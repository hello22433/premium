import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { OrderPaymentAllocationLineEntity } from '../../entity/order.payment.allocation.line.entity';
import { OrderPointUsageEntity } from '../../entity/order.point.usage.entity';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { PointGrantEntity } from '../../entity/point.grant.entity';
import {
  OrderDeliveryAttemptEntity,
  OrderDeliveryAttemptStatus,
  OrderDeliveryAttemptType,
} from '../../entity/order.delivery.attempt.entity';
import { WalletResourceType } from '../interface/wallet-resource-type';
import { buildConfirmReleaseKey, ORDER_LEVEL_SENTINEL } from '../interface/wallet-idempotency';
import { OrderEntity } from '../../entity/order.entity';
import { assertAllocationCodeNotMoved } from './reversal-move-guard';

const CONFIRM_RELEASE_TX_TYPE = 'CONFIRM_RELEASE';

export interface ReleaseConfirmationInput {
  orderId: number;
  reason: string;
  /**
   * null = 주문 단위 보상 (모든 delivery + 모든 resource).
   * 배열 전달 시 해당 delivery 의 INITIAL attempt 만 ROLLED_BACK 처리.
   * wallet/legacy mirror 복구는 항상 allocation 전체 (allocation 단위 라이프사이클).
   */
  failedDeliveryIds: number[] | null;
}

export interface ReleaseConfirmationResult {
  alreadyReleased: boolean;
  walletTransactionIds: string[];
  rolledBackAttemptIds: string[];
}

/**
 * Cutover Bundle PR2-004: 발송확정 TX commit 이후 외부 호출 / 메시지 enqueue 실패 보상 service.
 *
 * 흐름 (one-shot 보상, plan v2.1 §2 single-shot + sentinel):
 *   1. allocation FOR UPDATE → 기존 confirm 결과 조회
 *   2. allocation.released_at 이미 set → idempotent return
 *   3. wallet_account 잔액 복구 (deposit += , credit_used -= , credit_excess -= )
 *   4. point_grant.remaining_amount 복구 (각 grant 별)
 *   5. INITIAL attempt status → ROLLED_BACK
 *   6. allocation.released_at + release_reason 갱신 (DROP 아님, 감사 + idempotency)
 *   7. wallet_transaction.type='CONFIRM_RELEASE' row (resource 별) — idempotency = buildConfirmReleaseKey(orderId, null|deliveryId, resource)
 *
 * 호출자가 외부 manager 전달 시 같은 TX 안에서 실행 (legacy mirror 복구와 묶음).
 * 미전달 시 자체 TX.
 *
 * 후속 hook 의 wallet-managed 판단 키:
 *   isWalletManaged = EXISTS(allocation WHERE order_id=? AND released_at IS NULL)
 * → released 된 allocation 은 legacy path 회귀 (plan Round 3 결정).
 */
@Injectable()
export class OrderConfirmationReleaseService {
  private readonly logger = new Logger(OrderConfirmationReleaseService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async releaseConfirmation(
    input: ReleaseConfirmationInput,
    externalManager?: EntityManager,
  ): Promise<ReleaseConfirmationResult> {
    if (externalManager) {
      return this.runOnManager(input, externalManager);
    }
    return this.dataSource.transaction(async (m) => this.runOnManager(input, m));
  }

  private async runOnManager(
    input: ReleaseConfirmationInput,
    manager: EntityManager,
  ): Promise<ReleaseConfirmationResult> {
    // 0. peek allocation (no lock — walletAccountId 확보용).
    //    Plan §3 lock 순서: wallet_account → allocation. 두 row 모두 단일 트랜잭션 안에서 잡으려면
    //    walletAccountId 를 먼저 알아야 하므로 peek 후 표준 순서대로 lock 한다.
    const peekAlloc = await manager.findOne(OrderPaymentAllocationEntity, {
      where: { orderId: input.orderId },
    });
    if (!peekAlloc) {
      throw new BadRequestException(
        `OrderConfirmationReleaseService: allocation not found for orderId=${input.orderId} (drift — confirm hook 실행 안 됨?)`,
      );
    }
    if (peekAlloc.releasedAt != null) {
      this.logger.warn(
        `confirm_release idempotent no-op: orderId=${input.orderId} releasedAt=${peekAlloc.releasedAt.toISOString()} reason='${peekAlloc.releaseReason}'`,
      );
      return { alreadyReleased: true, walletTransactionIds: [], rolledBackAttemptIds: [] };
    }

    // 1. wallet_account FOR UPDATE (lock 표준 §3 — wallet 먼저)
    const wallet = await manager
      .getRepository(WalletAccountEntity)
      .createQueryBuilder('w')
      .setLock('pessimistic_write')
      .where('w.id = :id', { id: peekAlloc.walletAccountId })
      .getOne();
    if (!wallet) {
      throw new BadRequestException(
        `OrderConfirmationReleaseService: wallet_account not found id=${peekAlloc.walletAccountId}`,
      );
    }

    // 2. allocation FOR UPDATE (lock 표준 §3 — wallet 다음)
    const alloc = await manager
      .getRepository(OrderPaymentAllocationEntity)
      .createQueryBuilder('a')
      .setLock('pessimistic_write')
      .where('a.orderId = :orderId', { orderId: input.orderId })
      .getOne();
    if (!alloc) {
      throw new BadRequestException(
        `OrderConfirmationReleaseService: allocation disappeared after peek (orderId=${input.orderId})`,
      );
    }
    if (alloc.releasedAt != null) {
      // race: peek 와 lock 사이에 다른 TX 가 release. idempotent return.
      this.logger.warn(
        `confirm_release idempotent (race after lock): orderId=${input.orderId} releasedAt=${alloc.releasedAt.toISOString()}`,
      );
      return { alreadyReleased: true, walletTransactionIds: [], rolledBackAttemptIds: [] };
    }

    // H1: 정산코드 이동 후 역처리(보상 release) 차단.
    const order = await manager.findOne(OrderEntity, {
      where: { id: input.orderId },
      select: ['id', 'userId', 'clientUserId'],
    });
    if (!order) {
      throw new BadRequestException(`OrderConfirmationReleaseService: order not found id=${input.orderId}`);
    }
    await assertAllocationCodeNotMoved(manager, order, wallet.ownerId);

    const walletTransactionIds: string[] = [];

    const restoreDeposit = Math.max(0, alloc.depositUsedAmount - alloc.depositRestoredAmount);
    const restoreCredit = Math.max(0, alloc.creditUsedAmount - alloc.creditUsedRestoredAmount);
    const restoreExcess = Math.max(0, alloc.creditExcessAmount - alloc.creditExcessRestoredAmount);

    const orderSentinelId: null = null; // confirm_release 는 주문 단위 보상 — deliveryId sentinel='ORDER'

    if (restoreDeposit > 0 && wallet) {
      wallet.depositBalance += restoreDeposit;
      await manager.save(WalletAccountEntity, wallet);
      const tx = await manager.save(WalletTransactionEntity, {
        walletAccountId: alloc.walletAccountId,
        orderId: input.orderId,
        orderDeliveryId: null,
        type: CONFIRM_RELEASE_TX_TYPE,
        resourceType: WalletResourceType.DEPOSIT,
        amount: restoreDeposit,
        balanceAfter: wallet.depositBalance,
        memo: input.reason.slice(0, 500),
        idempotencyKey: buildConfirmReleaseKey(input.orderId, orderSentinelId, WalletResourceType.DEPOSIT),
      });
      walletTransactionIds.push(tx.id);
    }
    if (restoreCredit > 0 && wallet) {
      wallet.creditUsedAmount -= restoreCredit;
      await manager.save(WalletAccountEntity, wallet);
      const tx = await manager.save(WalletTransactionEntity, {
        walletAccountId: alloc.walletAccountId,
        orderId: input.orderId,
        orderDeliveryId: null,
        type: CONFIRM_RELEASE_TX_TYPE,
        resourceType: WalletResourceType.CREDIT,
        amount: -restoreCredit,
        balanceAfter: wallet.creditUsedAmount,
        memo: input.reason.slice(0, 500),
        idempotencyKey: buildConfirmReleaseKey(input.orderId, orderSentinelId, WalletResourceType.CREDIT),
      });
      walletTransactionIds.push(tx.id);
    }
    if (restoreExcess > 0 && wallet) {
      wallet.creditExcessAmount -= restoreExcess;
      await manager.save(WalletAccountEntity, wallet);
      const tx = await manager.save(WalletTransactionEntity, {
        walletAccountId: alloc.walletAccountId,
        orderId: input.orderId,
        orderDeliveryId: null,
        type: CONFIRM_RELEASE_TX_TYPE,
        resourceType: WalletResourceType.CREDIT_EXCESS,
        amount: -restoreExcess,
        balanceAfter: wallet.creditExcessAmount,
        memo: input.reason.slice(0, 500),
        idempotencyKey: buildConfirmReleaseKey(input.orderId, orderSentinelId, WalletResourceType.CREDIT_EXCESS),
      });
      walletTransactionIds.push(tx.id);
    }

    // 4. point_grant 복구 (grant 단위 row split)
    const usages = await manager.find(OrderPointUsageEntity, {
      where: { allocationId: alloc.id },
    });
    const grantAgg: Record<string, number> = {};
    for (const u of usages) {
      const restorable = u.usedAmount - u.restoredAmount - u.skippedExpiredAmount;
      if (restorable > 0) {
        grantAgg[u.pointGrantId] = (grantAgg[u.pointGrantId] ?? 0) + restorable;
      }
    }
    for (const [grantId, amount] of Object.entries(grantAgg)) {
      const upd = await manager
        .createQueryBuilder()
        .update(PointGrantEntity)
        .set({ remainingAmount: () => `remaining_amount + ${amount}` })
        .where('id = :id AND active = 1', { id: grantId })
        .execute();
      if (upd.affected !== 1) {
        throw new BadRequestException(
          `OrderConfirmationReleaseService: point_grant restore conflict (id=${grantId}, amount=${amount})`,
        );
      }
      const refreshed = await manager.findOne(PointGrantEntity, { where: { id: grantId } });
      const tx = await manager.save(WalletTransactionEntity, {
        walletAccountId: alloc.walletAccountId,
        orderId: input.orderId,
        orderDeliveryId: null,
        type: CONFIRM_RELEASE_TX_TYPE,
        resourceType: WalletResourceType.POINT,
        amount,
        balanceAfter: refreshed?.remainingAmount ?? null,
        memo: input.reason.slice(0, 500),
        idempotencyKey: buildConfirmReleaseKey(
          input.orderId,
          orderSentinelId,
          WalletResourceType.POINT,
          Number(grantId),
        ),
      });
      walletTransactionIds.push(tx.id);
    }

    // 4-b. usage row restored 누적 갱신 (allocation 단위 audit)
    for (const u of usages) {
      const restorable = u.usedAmount - u.restoredAmount - u.skippedExpiredAmount;
      if (restorable > 0) {
        u.restoredAmount += restorable;
        await manager.save(OrderPointUsageEntity, u);
      }
    }

    // 5. INITIAL attempt status → ROLLED_BACK
    const attemptWhere: { [k: string]: unknown } = {
      attemptType: OrderDeliveryAttemptType.INITIAL,
      status: In([OrderDeliveryAttemptStatus.DEDUCTED, OrderDeliveryAttemptStatus.PENDING]),
    };
    if (input.failedDeliveryIds && input.failedDeliveryIds.length > 0) {
      attemptWhere.orderDeliveryId = In(input.failedDeliveryIds);
    } else {
      // null = 주문 전체 INITIAL 모두. 라인의 delivery 로 제한 (다른 주문 영향 차단)
      const lineDeliveries = await manager
        .getRepository(OrderPaymentAllocationLineEntity)
        .createQueryBuilder('l')
        .select('DISTINCT l.orderDeliveryId', 'orderDeliveryId')
        .where('l.allocationId = :id', { id: alloc.id })
        .andWhere('l.orderDeliveryId IS NOT NULL')
        .getRawMany<{ orderDeliveryId: number }>();
      if (lineDeliveries.length === 0) {
        // legacy fallback 흐름 (delivery 없음) — INITIAL row 자체가 없을 수 있음
        return { alreadyReleased: false, walletTransactionIds, rolledBackAttemptIds: [] };
      }
      attemptWhere.orderDeliveryId = In(lineDeliveries.map((r) => r.orderDeliveryId));
    }

    const attempts = await manager.find(OrderDeliveryAttemptEntity, { where: attemptWhere as never });
    const rolledBackAttemptIds: string[] = [];
    for (const att of attempts) {
      att.status = OrderDeliveryAttemptStatus.ROLLED_BACK;
      att.failedAt = att.failedAt ?? new Date();
      att.failureReason = input.reason.slice(0, 500);
      await manager.save(OrderDeliveryAttemptEntity, att);
      rolledBackAttemptIds.push(att.id);
    }

    // 6. allocation.released_at + release_reason 갱신
    alloc.releasedAt = new Date();
    alloc.releaseReason = input.reason.slice(0, 200);
    // restored 누적도 갱신 (감사 + idempotency)
    if (restoreDeposit > 0) alloc.depositRestoredAmount += restoreDeposit;
    if (restoreCredit > 0) alloc.creditUsedRestoredAmount += restoreCredit;
    if (restoreExcess > 0) alloc.creditExcessRestoredAmount += restoreExcess;
    for (const [, amount] of Object.entries(grantAgg)) {
      alloc.pointRestoredAmount += amount;
    }
    await manager.save(OrderPaymentAllocationEntity, alloc);

    this.logger.log(
      `confirm_release orderId=${input.orderId} sentinel=${ORDER_LEVEL_SENTINEL} attempts=${rolledBackAttemptIds.length} txs=${walletTransactionIds.length} reason='${input.reason}'`,
    );

    return { alreadyReleased: false, walletTransactionIds, rolledBackAttemptIds };
  }

  /**
   * 후속 hook 이 wallet-managed 여부 판단 시 사용하는 보조 predicate.
   * (WalletManagedPredicate 와 의도 동일 — 둘 중 하나만 호출하면 됨. 본 서비스 안에서는 직접 사용 안 함.)
   */
  static isReleasedAt(alloc: Pick<OrderPaymentAllocationEntity, 'releasedAt'> | null | undefined): boolean {
    return alloc != null && alloc.releasedAt != null;
  }
}
