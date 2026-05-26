import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { OrderEntity } from '../../entity/order.entity';
import { UserEntity } from '../../entity/user.entity';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { WalletResourceType } from '../interface/wallet-resource-type';
import { getBillingUserId } from '../../order/domain/order.billing-user.helper';

const SETTLE_RELEASE_TYPE = 'SETTLE_RELEASE';
const SETTLE_UNDO_TYPE = 'SETTLE_UNDO';

/**
 * idempotencyKey 포맷: settle_release:{orderId}::{resource}:{cycle}.
 * 마지막 segment 가 cycle id (예: `123_2`).
 */
function parseCycleFromIdempotencyKey(key: string): string {
  const parts = key.split(':');
  return parts[parts.length - 1] ?? '';
}

export interface SettleConfirmResult {
  creditReleased: number;
  excessReleased: number;
  settleCycleId: string;
  walletTransactionIds: string[];
}

export interface SettleUndoResult {
  creditRestored: number;
  excessRestored: number;
  settleCycleId: string;
  walletTransactionIds: string[];
}

/**
 * 정산확정/정산해제 wallet 통합 (Cross-Cutting Invariants §2 settle_release / settle_undo).
 *
 * plan v2.1 MAJOR fix 5 Q3 — settle_cycle_id = inline `{orderId}_{seq}`.
 * seq = COALESCE(MAX(seq), 0) + 1 FROM wallet_transaction WHERE order_id=? AND type IN
 *   ('SETTLE_RELEASE','SETTLE_UNDO') FOR UPDATE. wallet_account FOR UPDATE 가 동일 트랜잭션 안에서
 *   serialize 하므로 race-free.
 *
 * plan v2.1 MAJOR fix 5 Q5 / Improvement 1 — mirror owner = getBillingUserId(order)
 *   = order.clientUserId ?? order.userId. 대행주문(clientUserId IS NOT NULL) 의 외상 누적이
 *   대행 실 과금 대상 user 로 귀속.
 *
 * Lock 순서 표준 (plan §3): wallet_account → allocation → wallet_transaction.
 */
@Injectable()
export class SettleConfirmationWalletService {
  private readonly logger = new Logger(SettleConfirmationWalletService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async confirmSettlement(
    orderId: number,
    externalManager?: EntityManager,
  ): Promise<SettleConfirmResult> {
    if (externalManager) {
      return this.runConfirm(orderId, externalManager);
    }
    return this.dataSource.transaction(async (m) => this.runConfirm(orderId, m));
  }

  /**
   * 정산해제. 마지막 settle_release cycle 을 lookup 해 동일 amount 만큼 복원한다.
   *  - 마지막 cycle 에 매칭되는 settle_undo 가 이미 존재 → idempotent return (cycle id 그대로).
   *  - settle_release 가 한 건도 없으면 throw (정산확정 안 한 주문 undo 시도).
   */
  async undoSettlement(
    orderId: number,
    externalManager?: EntityManager,
  ): Promise<SettleUndoResult> {
    if (externalManager) {
      return this.runUndo(orderId, externalManager);
    }
    return this.dataSource.transaction(async (m) => this.runUndo(orderId, m));
  }

  private async runConfirm(orderId: number, manager: EntityManager): Promise<SettleConfirmResult> {
    const { alloc, walletLock, order } = await this.lockChainAndLoad(orderId, manager);

    // 잔여분만 release (실패/폐기 환불분 제외)
    const creditReleased = Math.max(0, alloc.creditUsedAmount - alloc.creditUsedRestoredAmount);
    const excessReleased = Math.max(0, alloc.creditExcessAmount - alloc.creditExcessRestoredAmount);
    const totalReleased = creditReleased + excessReleased;

    // race-free seq — wallet_account FOR UPDATE 보유 상태에서 SETTLE_RELEASE/UNDO row count
    const seq = await this.nextSettleSeq(orderId, manager);
    const settleCycleId = `${orderId}_${seq}`;
    const walletTransactionIds: string[] = [];

    if (creditReleased > 0) {
      walletLock.creditUsedAmount -= creditReleased;
      await manager.save(WalletAccountEntity, walletLock);
      const tx = await manager.save(WalletTransactionEntity, {
        walletAccountId: alloc.walletAccountId,
        orderId,
        orderDeliveryId: null,
        type: SETTLE_RELEASE_TYPE,
        resourceType: WalletResourceType.CREDIT,
        amount: -creditReleased,
        balanceAfter: walletLock.creditUsedAmount,
        memo: `settle_release ${settleCycleId}`,
        idempotencyKey: `settle_release:${orderId}::credit:${settleCycleId}`,
      });
      walletTransactionIds.push(tx.id);
    }

    if (excessReleased > 0) {
      walletLock.creditExcessAmount -= excessReleased;
      await manager.save(WalletAccountEntity, walletLock);
      const tx = await manager.save(WalletTransactionEntity, {
        walletAccountId: alloc.walletAccountId,
        orderId,
        orderDeliveryId: null,
        type: SETTLE_RELEASE_TYPE,
        resourceType: WalletResourceType.CREDIT_EXCESS,
        amount: -excessReleased,
        balanceAfter: walletLock.creditExcessAmount,
        memo: `settle_release ${settleCycleId}`,
        idempotencyKey: `settle_release:${orderId}::credit_excess:${settleCycleId}`,
      });
      walletTransactionIds.push(tx.id);
    }

    // legacy mirror — user.allSettleAmount 감소 (billing user owner).
    if (totalReleased > 0) {
      const billingUserId = getBillingUserId(order);
      await manager
        .getRepository(UserEntity)
        .createQueryBuilder()
        .update()
        .set({ allSettleAmount: () => 'all_settle_amount - :amount' })
        .where('id = :id', { id: billingUserId })
        .setParameters({ amount: totalReleased })
        .execute();
    }

    this.logger.log(
      `settle_release orderId=${orderId} cycle=${settleCycleId} credit=${creditReleased} excess=${excessReleased}`,
    );

    return { creditReleased, excessReleased, settleCycleId, walletTransactionIds };
  }

  private async runUndo(orderId: number, manager: EntityManager): Promise<SettleUndoResult> {
    const { alloc, walletLock, order } = await this.lockChainAndLoad(orderId, manager);

    // 마지막 settle_release cycle lookup
    const releaseTxs = await manager
      .getRepository(WalletTransactionEntity)
      .createQueryBuilder('t')
      .where('t.orderId = :orderId', { orderId })
      .andWhere('t.type = :type', { type: SETTLE_RELEASE_TYPE })
      .orderBy('t.id', 'DESC')
      .getMany();
    if (releaseTxs.length === 0) {
      throw new BadRequestException(
        `SettleConfirmationWalletService: no settle_release found for orderId=${orderId} (정산확정 안 한 주문)`,
      );
    }
    const latestCycle = parseCycleFromIdempotencyKey(releaseTxs[0].idempotencyKey);
    const cycleReleaseTxs = releaseTxs.filter(
      (t) => parseCycleFromIdempotencyKey(t.idempotencyKey) === latestCycle,
    );

    // 멱등 — 이미 같은 cycle 로 undo 된 row 있으면 short-circuit return
    const existingUndo = await manager
      .getRepository(WalletTransactionEntity)
      .createQueryBuilder('t')
      .where('t.orderId = :orderId', { orderId })
      .andWhere('t.type = :type', { type: SETTLE_UNDO_TYPE })
      .andWhere('t.idempotencyKey LIKE :pat', { pat: `%:${latestCycle}` })
      .getMany();
    if (existingUndo.length > 0) {
      this.logger.warn(
        `settle_undo idempotent no-op: orderId=${orderId} cycle=${latestCycle} existing=${existingUndo.length}`,
      );
      return {
        creditRestored: 0,
        excessRestored: 0,
        settleCycleId: latestCycle,
        walletTransactionIds: [],
      };
    }

    let creditRestored = 0;
    let excessRestored = 0;
    const walletTransactionIds: string[] = [];

    for (const releaseTx of cycleReleaseTxs) {
      const amount = Math.abs(releaseTx.amount);
      if (releaseTx.resourceType === WalletResourceType.CREDIT) {
        walletLock.creditUsedAmount += amount;
        creditRestored += amount;
        await manager.save(WalletAccountEntity, walletLock);
        const tx = await manager.save(WalletTransactionEntity, {
          walletAccountId: alloc.walletAccountId,
          orderId,
          orderDeliveryId: null,
          type: SETTLE_UNDO_TYPE,
          resourceType: WalletResourceType.CREDIT,
          amount,
          balanceAfter: walletLock.creditUsedAmount,
          memo: `settle_undo ${latestCycle}`,
          idempotencyKey: `settle_undo:${orderId}::credit:${latestCycle}`,
        });
        walletTransactionIds.push(tx.id);
      } else if (releaseTx.resourceType === WalletResourceType.CREDIT_EXCESS) {
        walletLock.creditExcessAmount += amount;
        excessRestored += amount;
        await manager.save(WalletAccountEntity, walletLock);
        const tx = await manager.save(WalletTransactionEntity, {
          walletAccountId: alloc.walletAccountId,
          orderId,
          orderDeliveryId: null,
          type: SETTLE_UNDO_TYPE,
          resourceType: WalletResourceType.CREDIT_EXCESS,
          amount,
          balanceAfter: walletLock.creditExcessAmount,
          memo: `settle_undo ${latestCycle}`,
          idempotencyKey: `settle_undo:${orderId}::credit_excess:${latestCycle}`,
        });
        walletTransactionIds.push(tx.id);
      }
    }

    const totalRestored = creditRestored + excessRestored;
    if (totalRestored > 0) {
      const billingUserId = getBillingUserId(order);
      await manager
        .getRepository(UserEntity)
        .createQueryBuilder()
        .update()
        .set({ allSettleAmount: () => 'all_settle_amount + :amount' })
        .where('id = :id', { id: billingUserId })
        .setParameters({ amount: totalRestored })
        .execute();
    }

    this.logger.log(
      `settle_undo orderId=${orderId} cycle=${latestCycle} credit=${creditRestored} excess=${excessRestored}`,
    );

    return {
      creditRestored,
      excessRestored,
      settleCycleId: latestCycle,
      walletTransactionIds,
    };
  }

  /**
   * Lock 표준 §3: wallet_account FOR UPDATE → allocation FOR UPDATE.
   * walletAccountId 확보용 peek 후 표준 순서대로 lock.
   * 추가로 order entity 도 함께 로드 — mirror UPDATE 대상 user 결정 (getBillingUserId).
   */
  private async lockChainAndLoad(
    orderId: number,
    manager: EntityManager,
  ): Promise<{ alloc: OrderPaymentAllocationEntity; walletLock: WalletAccountEntity; order: OrderEntity }> {
    const peekAlloc = await manager.findOne(OrderPaymentAllocationEntity, { where: { orderId } });
    if (!peekAlloc) {
      throw new BadRequestException(
        `SettleConfirmationWalletService: allocation not found for orderId=${orderId}`,
      );
    }

    const walletLock = await manager
      .getRepository(WalletAccountEntity)
      .createQueryBuilder('w')
      .setLock('pessimistic_write')
      .where('w.id = :id', { id: peekAlloc.walletAccountId })
      .getOne();
    if (!walletLock) {
      throw new BadRequestException(
        `SettleConfirmationWalletService: wallet_account not found id=${peekAlloc.walletAccountId}`,
      );
    }

    const alloc = await manager
      .getRepository(OrderPaymentAllocationEntity)
      .createQueryBuilder('a')
      .setLock('pessimistic_write')
      .where('a.orderId = :orderId', { orderId })
      .getOne();
    if (!alloc) {
      throw new BadRequestException(
        `SettleConfirmationWalletService: allocation disappeared after peek (orderId=${orderId})`,
      );
    }

    const order = await manager.findOne(OrderEntity, { where: { id: orderId } });
    if (!order) {
      throw new BadRequestException(`SettleConfirmationWalletService: order not found id=${orderId}`);
    }

    return { alloc, walletLock, order };
  }

  /**
   * MAJOR fix 5 Q3 — race-free seq.
   * wallet_account FOR UPDATE 보유 상태에서 settle_release/undo type row count + 1.
   * 같은 wallet 의 settle 흐름이 직렬화돼 seq 중복 0건 보장.
   */
  private async nextSettleSeq(orderId: number, manager: EntityManager): Promise<number> {
    const row = await manager
      .getRepository(WalletTransactionEntity)
      .createQueryBuilder('t')
      .select('COUNT(*)', 'cnt')
      .where('t.orderId = :orderId', { orderId })
      .andWhere('t.type IN (:...types)', { types: [SETTLE_RELEASE_TYPE, SETTLE_UNDO_TYPE] })
      .getRawOne<{ cnt: string }>();
    const cnt = Number(row?.cnt ?? 0);
    return cnt + 1;
  }
}
