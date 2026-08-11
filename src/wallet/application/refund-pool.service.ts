import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { OrderPaymentAllocationLineEntity } from '../../entity/order.payment.allocation.line.entity';
import {
  OrderPaymentRefundEventEntity,
  OrderPaymentRefundEventType,
} from '../../entity/order.payment.refund.event.entity';
import { OrderPointUsageEntity } from '../../entity/order.point.usage.entity';
import { PointGrantEntity } from '../../entity/point.grant.entity';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { PaymentAllocationService } from './payment-allocation.service';
import { WalletResourceType } from '../interface/wallet-resource-type';
import { OrderEntity } from '../../entity/order.entity';
import { assertAllocationCodeNotMoved } from './reversal-move-guard';

export interface RefundEventInput {
  orderId: number;
  eventType: OrderPaymentRefundEventType;
  targetDeliveryIds: number[]; // 환불 대상 (라인 단위 ledger row 생성)
  idempotencyKeyPrefix: string; // ex) `fail_refund:${orderId}:${deliveryId}:${attempt_id}`
  attemptId?: string;
  refundFromAttemptTransactions?: boolean;
}

export interface SettledDiscardRefundInput {
  orderId: number;
  orderDeliveryId: number;
  refundAmount: number;
  idempotencyKeyPrefix: string;
}

export interface RefundEventResult {
  ledgerIds: string[]; // 라인별 ledger row PK
  totalRefundedAmount: number; // 실제 복구액 합계. 만료 포인트 skip은 pointSkippedExpiredAmount로 별도 반환.
  refundedPointAmount: number;
  refundedDepositAmount: number;
  refundedCreditUsedAmount: number;
  refundedCreditExcessAmount: number;
  pointSkippedExpiredAmount: number;
  // 이번 호출이 실제로 잔액/ledger 를 변경했는지 여부.
  //  - false: 신규 환불 적용됨 (wallet/allocation 변경 발생).
  //  - true : 멱등 retry — 기존 ledger 결과만 반환, 잔액 미변경 (no-op).
  // caller 가 legacy mirror 같은 ledger 외 부수효과를 멱등하게 가드하는 데 쓴다.
  alreadyRefunded: boolean;
}

/**
 * Cross-Cutting Invariants §8 환불 알고리즘 구현 (풀 기반 + ledger).
 *  - allocation FOR UPDATE row lock.
 *  - already_refunded 체크.
 *  - 라인 payable_base ASC 정렬 후 한 라인씩 ledger row 생성.
 *  - 실패 환불: 포인트 → 신용초과 → 여신 → 예치금.
 *  - 정산확정 전 개별 폐기: 포인트 → 신용초과 → 예치금 → 여신.
 *  - 만료 포인트 skip (skip 금액은 다음 우선순위로 넘기지 않음).
 *  - 카드할증 delta = applyCardSurcharge(before) - applyCardSurcharge(after).
 *
 * 재발송 역환불 (reverseRefund) 은 ledger 금액 그대로 차감 복구.
 */
@Injectable()
export class RefundPoolService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly allocation: PaymentAllocationService,
  ) {}

  async refund(input: RefundEventInput, externalManager?: EntityManager): Promise<RefundEventResult> {
    if (externalManager) {
      // caller 가 이미 트랜잭션 안 → same manager 로 실행. isolation 은 caller TX 설정 따름.
      // (caller 가 READ COMMITTED 보장 필요 — wallet path 진입부에서 알림.)
      return this.runRefund(input, externalManager);
    }
    // READ COMMITTED 명시 — MySQL 기본 REPEATABLE READ 에서는 lock 획득 후 plain SELECT 가 트랜잭션 시작 시점의
    // consistent snapshot 을 보아 방금 다른 트랜잭션이 commit 한 refund ledger 를 못 볼 수 있다.
    // lock 후 same-prefix 재조회 (HIGH 2 fix) 가 의도대로 동작하려면 isolation 을 낮춰 current read 가 보이게 해야 한다.
    return this.dataSource.transaction('READ COMMITTED', async (m) => this.runRefund(input, m));
  }

  async refundSettledDiscardToDeposit(
    input: SettledDiscardRefundInput,
    externalManager?: EntityManager,
  ): Promise<RefundEventResult> {
    if (externalManager) {
      return this.runSettledDiscardToDeposit(input, externalManager);
    }
    return this.dataSource.transaction('READ COMMITTED', async (m) => this.runSettledDiscardToDeposit(input, m));
  }

  private async runSettledDiscardToDeposit(
    input: SettledDiscardRefundInput,
    manager: EntityManager,
  ): Promise<RefundEventResult> {
    const ledgerKey = `${input.idempotencyKeyPrefix}:settled`;
    const existingForPrefix = await manager
      .getRepository(OrderPaymentRefundEventEntity)
      .createQueryBuilder('e')
      .where('e.idempotencyKey LIKE :prefix', { prefix: `${ledgerKey}%` })
      .andWhere('e.reversedAt IS NULL')
      .getMany();
    if (existingForPrefix.length > 0) {
      return this.buildRefundResult(existingForPrefix, true);
    }

    const peekAlloc = await manager.findOne(OrderPaymentAllocationEntity, {
      where: { orderId: input.orderId },
    });
    if (!peekAlloc) {
      throw new BadRequestException(`allocation not found for orderId=${input.orderId}`);
    }

    const walletLock = await manager
      .getRepository(WalletAccountEntity)
      .createQueryBuilder('w')
      .setLock('pessimistic_write')
      .where('w.id = :id', { id: peekAlloc.walletAccountId })
      .getOne();
    if (!walletLock) {
      throw new BadRequestException(
        `wallet_account not found id=${peekAlloc.walletAccountId} for allocation ${peekAlloc.id}`,
      );
    }

    const alloc = await manager
      .getRepository(OrderPaymentAllocationEntity)
      .createQueryBuilder('a')
      .setLock('pessimistic_write')
      .where('a.orderId = :orderId', { orderId: input.orderId })
      .getOne();
    if (!alloc) {
      throw new BadRequestException(`allocation disappeared after peek (orderId=${input.orderId})`);
    }

    const existingAfterLock = await manager
      .getRepository(OrderPaymentRefundEventEntity)
      .createQueryBuilder('e')
      .setLock('pessimistic_read')
      .where('e.idempotencyKey LIKE :prefix', { prefix: `${ledgerKey}%` })
      .andWhere('e.reversedAt IS NULL')
      .getMany();
    if (existingAfterLock.length > 0) {
      return this.buildRefundResult(existingAfterLock, true);
    }

    const activeEvents = await manager
      .getRepository(OrderPaymentRefundEventEntity)
      .createQueryBuilder('e')
      .setLock('pessimistic_read')
      .where('e.allocationId = :allocationId', { allocationId: alloc.id })
      .andWhere('e.reversedAt IS NULL')
      .getMany();
    for (const ev of activeEvents) {
      if ((ev.affectedDeliveryIds ?? []).includes(input.orderDeliveryId)) {
        throw new BadRequestException('already_refunded');
      }
    }

    // H1: 정산코드 이동 후 환불(폐기환불) 차단.
    await this.assertReversalCodeNotMoved(manager, input.orderId, walletLock.ownerId);

    const pointRefund = await this.refundPointsForSettledDiscard(input, alloc, manager);
    const depositRefundAmount = input.refundAmount - pointRefund.restored - pointRefund.skipped;
    if (depositRefundAmount < 0) {
      throw new BadRequestException(
        `settled discard refund invariant violation: pointRefund=${pointRefund.restored + pointRefund.skipped} > refundAmount=${input.refundAmount}`,
      );
    }

    if (depositRefundAmount > 0) {
      walletLock.depositBalance += depositRefundAmount;
      await manager.save(WalletAccountEntity, walletLock);
      await manager.save(WalletTransactionEntity, {
        walletAccountId: alloc.walletAccountId,
        orderId: input.orderId,
        orderDeliveryId: input.orderDeliveryId,
        type: 'DISCARD_REFUND',
        resourceType: WalletResourceType.DEPOSIT,
        amount: depositRefundAmount,
        balanceAfter: walletLock.depositBalance,
        memo: 'settled discard refund to deposit',
        idempotencyKey: `${ledgerKey}:wallet`,
      });
    }

    for (const [grantId, info] of Object.entries(pointRefund.restoredByGrant)) {
      await manager.save(WalletTransactionEntity, {
        walletAccountId: alloc.walletAccountId,
        orderId: input.orderId,
        orderDeliveryId: input.orderDeliveryId,
        type: 'DISCARD_REFUND',
        resourceType: WalletResourceType.POINT,
        amount: info.amount,
        balanceAfter: info.balanceAfter,
        memo: 'settled discard refund to point',
        idempotencyKey: `${ledgerKey}:point:${grantId}`,
      });
    }

    if (pointRefund.skipped > 0) {
      await manager.save(WalletTransactionEntity, {
        walletAccountId: alloc.walletAccountId,
        orderId: input.orderId,
        orderDeliveryId: input.orderDeliveryId,
        type: 'RESTORE_SKIPPED_EXPIRED',
        resourceType: WalletResourceType.POINT,
        amount: 0,
        balanceAfter: null,
        memo: `expired_point_skipped=${pointRefund.skipped}`,
        idempotencyKey: `${ledgerKey}:point_skipped_expired`,
      });
    }

    alloc.depositRestoredAmount += depositRefundAmount;
    alloc.pointRestoredAmount += pointRefund.restored;
    alloc.pointSkippedExpiredAmount += pointRefund.skipped;
    await manager.save(OrderPaymentAllocationEntity, alloc);

    const ledger = await manager.save(OrderPaymentRefundEventEntity, {
      allocationId: alloc.id,
      orderId: input.orderId,
      eventType: OrderPaymentRefundEventType.DISCARD_REFUND,
      affectedDeliveryIds: [input.orderDeliveryId],
      refundedGrossBase: input.refundAmount,
      refundedPayableBase: depositRefundAmount,
      refundedCardSurchargeAmount: 0,
      refundedPointAmount: pointRefund.restored,
      refundedDepositAmount: depositRefundAmount,
      refundedCreditUsedAmount: 0,
      refundedCreditExcessAmount: 0,
      pointSkippedExpiredAmount: pointRefund.skipped,
      idempotencyKey: ledgerKey,
      reversedAt: null,
      reversedByWalletTransactionId: null,
    });

    return this.buildRefundResult([ledger], false);
  }

  private async refundPointsForSettledDiscard(
    input: SettledDiscardRefundInput,
    alloc: OrderPaymentAllocationEntity,
    manager: EntityManager,
  ): Promise<{
    restored: number;
    skipped: number;
    restoredByGrant: Record<string, { amount: number; balanceAfter: number }>;
  }> {
    const usages = await manager.find(OrderPointUsageEntity, {
      where: {
        allocationId: alloc.id,
        orderDeliveryId: input.orderDeliveryId,
      },
      order: { id: 'ASC' },
    });
    let restored = 0;
    let skipped = 0;
    const restoredByGrant: Record<string, { amount: number; balanceAfter: number }> = {};
    for (const usage of usages) {
      if (restored + skipped >= input.refundAmount) break;
      const grant = await manager.findOne(PointGrantEntity, { where: { id: usage.pointGrantId } });
      const expired = grant?.expiresAt != null && grant.expiresAt < new Date();
      const usageRemaining = usage.usedAmount - usage.restoredAmount - usage.skippedExpiredAmount;
      const portion = Math.min(input.refundAmount - restored - skipped, usageRemaining);
      if (portion <= 0) continue;
      if (expired) {
        usage.skippedExpiredAmount += portion;
        skipped += portion;
      } else {
        const upd = await manager
          .createQueryBuilder()
          .update(PointGrantEntity)
          .set({ remainingAmount: () => `remaining_amount + ${portion}` })
          .where('id = :id AND active = 1', { id: usage.pointGrantId, portion })
          .execute();
        if (upd.affected !== 1) {
          throw new BadRequestException(
            `settled discard point restore conflict (grantId=${usage.pointGrantId}, portion=${portion})`,
          );
        }
        const refreshed = await manager.findOne(PointGrantEntity, { where: { id: usage.pointGrantId } });
        usage.restoredAmount += portion;
        restored += portion;
        const prev = restoredByGrant[usage.pointGrantId]?.amount ?? 0;
        restoredByGrant[usage.pointGrantId] = {
          amount: prev + portion,
          balanceAfter: refreshed?.remainingAmount ?? 0,
        };
      }
      await manager.save(OrderPointUsageEntity, usage);
    }
    return { restored, skipped, restoredByGrant };
  }

  private async runRefund(input: RefundEventInput, manager: EntityManager): Promise<RefundEventResult> {
    // 0. retry idempotency: 동일 idempotencyKeyPrefix 으로 이미 ledger row 가 만들어졌으면 기존 결과 return.
    //    overlap 검사보다 먼저 — 같은 prefix retry 는 정상 처리됐던 결과를 BadRequest 가 아닌 200 으로 돌려야 worker 가 멈춤.
    const existingForPrefix = await manager
      .getRepository(OrderPaymentRefundEventEntity)
      .createQueryBuilder('e')
      .where('e.idempotencyKey LIKE :prefix', { prefix: `${input.idempotencyKeyPrefix}:%` })
      // reversed (재발송으로 역환불된) ledger 는 active 가 아니므로 retry hit 에서 제외.
      // 제외 안 하면 같은 prefix 재실패가 reversed ledger 를 success 로 반환해 새 환불이 no-op 된다.
      .andWhere('e.reversedAt IS NULL')
      .getMany();
    if (existingForPrefix.length > 0) {
      return this.buildRefundResult(existingForPrefix, true);
    }

    // Plan §3 lock 순서: wallet_account → allocation → wallet_transaction.
    // walletAccountId 확보를 위해 peek 후 표준 순서대로 lock.
    const peekAlloc = await manager.findOne(OrderPaymentAllocationEntity, {
      where: { orderId: input.orderId },
    });
    if (!peekAlloc) {
      throw new BadRequestException(`allocation not found for orderId=${input.orderId}`);
    }

    // 1) wallet_account FOR UPDATE — lock 표준 §3 우선순위 1.
    const walletLock = await manager
      .getRepository(WalletAccountEntity)
      .createQueryBuilder('w')
      .setLock('pessimistic_write')
      .where('w.id = :id', { id: peekAlloc.walletAccountId })
      .getOne();
    if (!walletLock) {
      throw new BadRequestException(
        `wallet_account not found id=${peekAlloc.walletAccountId} for allocation ${peekAlloc.id}`,
      );
    }

    // 2) allocation FOR UPDATE — lock 표준 §3 우선순위 2.
    const alloc = await manager
      .getRepository(OrderPaymentAllocationEntity)
      .createQueryBuilder('a')
      .setLock('pessimistic_write')
      .where('a.orderId = :orderId', { orderId: input.orderId })
      .getOne();
    if (!alloc) {
      throw new BadRequestException(`allocation disappeared after peek (orderId=${input.orderId})`);
    }

    // 0-b. lock 획득 후 same-prefix 재조회 — 동시 retry 2건 race 차단.
    //      첫 retry 가 lock 보유하면서 ledger 만들고 commit, 두 번째가 lock 받자마자 동일 prefix ledger 보면 success return.
    const existingAfterLock = await manager
      .getRepository(OrderPaymentRefundEventEntity)
      .createQueryBuilder('e')
      .setLock('pessimistic_read')
      .where('e.idempotencyKey LIKE :prefix', { prefix: `${input.idempotencyKeyPrefix}:%` })
      .andWhere('e.reversedAt IS NULL')
      .getMany();
    if (existingAfterLock.length > 0) {
      return this.buildRefundResult(existingAfterLock, true);
    }

    // allocation lock 획득 뒤 locking read로 현재 커밋된 이벤트를 읽는다.
    // 호출자 트랜잭션이 REPEATABLE READ여도 lock 전 snapshot에 고정되면 안 된다.
    const activeEvents = await manager
      .getRepository(OrderPaymentRefundEventEntity)
      .createQueryBuilder('e')
      .setLock('pessimistic_read')
      .where('e.allocationId = :allocationId', { allocationId: alloc.id })
      .andWhere('e.reversedAt IS NULL')
      .getMany();
    for (const ev of activeEvents) {
      const overlap = (ev.affectedDeliveryIds ?? []).some((d) => input.targetDeliveryIds.includes(d));
      if (overlap) {
        throw new BadRequestException('already_refunded');
      }
    }

    // H1: 정산코드 이동 후 환불(실패환불/폐기환불/재발송 역환불) 차단.
    await this.assertReversalCodeNotMoved(manager, input.orderId, walletLock.ownerId);

    if (input.refundFromAttemptTransactions) {
      return this.runRefundFromResendDeductTransactions(input, alloc, walletLock, manager);
    }

    // 환불 대상 라인 조회 + payable_base ASC 정렬 (작은 base 먼저)
    const lines = await manager
      .getRepository(OrderPaymentAllocationLineEntity)
      .createQueryBuilder('l')
      .where('l.allocationId = :id', { id: alloc.id })
      .andWhere('l.orderDeliveryId IN (:...ids)', { ids: input.targetDeliveryIds })
      .orderBy('l.payableBase', 'ASC')
      .addOrderBy('l.orderDeliveryId', 'ASC')
      .getMany();
    if (lines.length === 0) {
      throw new BadRequestException(`no allocation lines for deliveryIds=${input.targetDeliveryIds.join(',')}`);
    }

    // fail-closed preflight: point grant 등 어떤 mutation보다 먼저 allocation counter drift를 차단한다.
    this.availableResourceAmount(
      WalletResourceType.CREDIT_EXCESS,
      alloc.creditExcessAmount,
      alloc.creditExcessRestoredAmount,
    );
    this.availableResourceAmount(WalletResourceType.DEPOSIT, alloc.depositUsedAmount, alloc.depositRestoredAmount);
    this.availableResourceAmount(WalletResourceType.CREDIT, alloc.creditUsedAmount, alloc.creditUsedRestoredAmount);

    const ledgers: OrderPaymentRefundEventEntity[] = [];
    let activePayableSum = activeEvents.reduce((s, ev) => s + ev.refundedPayableBase, 0);
    let pointRestoredTotal = alloc.pointRestoredAmount;
    let creditExcessRestoredTotal = alloc.creditExcessRestoredAmount;
    let creditUsedRestoredTotal = alloc.creditUsedRestoredAmount;
    let depositRestoredTotal = alloc.depositRestoredAmount;
    let pointSkippedTotal = alloc.pointSkippedExpiredAmount;

    // 포인트는 allocation pool 기반 복구 (§8). 라인 단위 분배 아님.
    // 만료 임박순 (expires_at ASC, null 후순위) 으로 정렬해 만료 임박 grant 먼저 복구.
    const allUsages = await manager.find(OrderPointUsageEntity, { where: { allocationId: alloc.id } });
    const usagesWithGrant: Array<{ usage: OrderPointUsageEntity; grant: PointGrantEntity | null }> = [];
    for (const usage of allUsages) {
      const grant = await manager.findOne(PointGrantEntity, { where: { id: usage.pointGrantId } });
      usagesWithGrant.push({ usage, grant });
    }
    usagesWithGrant.sort((a, b) => {
      const ax = a.grant?.expiresAt ? a.grant.expiresAt.getTime() : Number.MAX_SAFE_INTEGER;
      const bx = b.grant?.expiresAt ? b.grant.expiresAt.getTime() : Number.MAX_SAFE_INTEGER;
      return ax - bx;
    });

    for (const line of lines) {
      // 1. base + 카드할증 delta
      const remainingPayableBaseBefore = alloc.grossSettlementAmount - alloc.pointUsedAmount - activePayableSum;
      const thisGrossBase = line.grossSettlementAmount;
      const thisPayableBase = thisGrossBase - line.pointUsedAmount;
      const remainingPayableBaseAfter = remainingPayableBaseBefore - thisPayableBase;
      if (remainingPayableBaseAfter < 0) {
        throw new BadRequestException(
          `over-refund detected: remainingPayableBaseAfter=${remainingPayableBaseAfter} < 0`,
        );
      }

      const cardApplied = alloc.cardSurchargeApplied === 1;
      const surchargeBefore =
        this.allocation.applyCardSurcharge(remainingPayableBaseBefore, cardApplied) - remainingPayableBaseBefore;
      const surchargeAfter =
        this.allocation.applyCardSurcharge(remainingPayableBaseAfter, cardApplied) - remainingPayableBaseAfter;
      const thisSurcharge = surchargeBefore - surchargeAfter;

      let refundRemaining = thisGrossBase + thisSurcharge;

      // 2. 우선순위 풀 차감 복구 (§8)
      // 2-1 포인트 — allocation pool 기반. 라인 line.pointUsedAmount 와 무관하게
      //           allocation 전체 사용 포인트 풀에서 만료 임박순으로 차감 복구.
      //   grant.remaining_amount 는 read-modify-save 가 아닌 조건부 UPDATE + affectedRows 검증 —
      //   서로 다른 allocation 이 같은 grant 를 동시에 복구할 때 lost update 방지.
      //   복구는 grant 단위로 집계 → grant 별 wallet_transaction row + balance_after 기록.
      let restorablePoint = 0;
      let skippedPoint = 0;
      const restoredByGrant: Record<string, { amount: number; balanceAfter: number }> = {};
      if (refundRemaining > 0) {
        const allocPointRemaining = alloc.pointUsedAmount - pointRestoredTotal - pointSkippedTotal;
        let pointToConsume = Math.min(refundRemaining, allocPointRemaining);
        for (const slot of usagesWithGrant) {
          if (pointToConsume <= 0) break;
          const { usage, grant } = slot;
          if (!grant) continue;
          const usageRemaining = usage.usedAmount - usage.restoredAmount - usage.skippedExpiredAmount;
          if (usageRemaining <= 0) continue;
          const portion = Math.min(pointToConsume, usageRemaining);
          const expired = grant.expiresAt != null && grant.expiresAt < new Date();
          if (expired) {
            skippedPoint += portion;
            usage.skippedExpiredAmount += portion;
          } else {
            const upd = await manager
              .createQueryBuilder()
              .update(PointGrantEntity)
              .set({ remainingAmount: () => `remaining_amount + ${portion}` })
              .where('id = :id AND active = 1', { id: grant.id })
              .execute();
            if (upd.affected !== 1) {
              throw new BadRequestException(`point_grant restore conflict (id=${grant.id}, portion=${portion})`);
            }
            const refreshed = await manager.findOne(PointGrantEntity, { where: { id: grant.id } });
            restorablePoint += portion;
            usage.restoredAmount += portion;
            const prev = restoredByGrant[grant.id]?.amount ?? 0;
            restoredByGrant[grant.id] = {
              amount: prev + portion,
              balanceAfter: refreshed?.remainingAmount ?? 0,
            };
          }
          await manager.save(OrderPointUsageEntity, usage);
          pointToConsume -= portion;
          refundRemaining -= portion;
        }
      }

      // 2-2 신용초과 (allocation 누적)
      const excessAvail = this.availableResourceAmount(
        WalletResourceType.CREDIT_EXCESS,
        alloc.creditExcessAmount,
        creditExcessRestoredTotal,
      );
      const restoreExcess = Math.min(refundRemaining, excessAvail);
      creditExcessRestoredTotal += restoreExcess;
      refundRemaining -= restoreExcess;

      const depositAvail = this.availableResourceAmount(
        WalletResourceType.DEPOSIT,
        alloc.depositUsedAmount,
        depositRestoredTotal,
      );
      const creditAvail = this.availableResourceAmount(
        WalletResourceType.CREDIT,
        alloc.creditUsedAmount,
        creditUsedRestoredTotal,
      );
      let restoreDeposit: number;
      let restoreCredit: number;
      if (input.eventType === OrderPaymentRefundEventType.DISCARD_REFUND) {
        // 정산확정 전 개별 폐기: 최대서비스한도 내 여신을 유지하고 예치금 사용분을 먼저 복구한다.
        restoreDeposit = Math.min(refundRemaining, depositAvail);
        refundRemaining -= restoreDeposit;
        restoreCredit = Math.min(refundRemaining, creditAvail);
        refundRemaining -= restoreCredit;
      } else {
        // 발송 실패 등 기존 정책: 정상 여신을 먼저 해소한 뒤 예치금을 복구한다.
        restoreCredit = Math.min(refundRemaining, creditAvail);
        refundRemaining -= restoreCredit;
        restoreDeposit = Math.min(refundRemaining, depositAvail);
        refundRemaining -= restoreDeposit;
      }
      depositRestoredTotal += restoreDeposit;
      creditUsedRestoredTotal += restoreCredit;

      if (refundRemaining !== 0) {
        throw new BadRequestException(`refund invariant violation: refundRemaining=${refundRemaining}`);
      }

      // 2-5. wallet_account 잔액 복구 + wallet_transaction row split (resource 별 1 row)
      // POINT 는 point_grant.remaining_amount 가 이미 갱신됨 (2-1 단계). wallet_transaction 만 추가.
      const walletTxBase = {
        walletAccountId: alloc.walletAccountId,
        orderId: input.orderId,
        orderDeliveryId: line.orderDeliveryId,
        type: input.eventType.toUpperCase(),
        memo: null as string | null,
      };
      const keyPrefix = `${input.idempotencyKeyPrefix}:line:${line.id}`;

      // wallet 은 transaction 진입 직후 walletLock 으로 lock 됨 (lock 표준 §3). 재 lock 금지.
      if (restoreDeposit > 0) {
        walletLock.depositBalance += restoreDeposit;
        await manager.save(WalletAccountEntity, walletLock);
        await manager.save(WalletTransactionEntity, {
          ...walletTxBase,
          resourceType: WalletResourceType.DEPOSIT,
          amount: restoreDeposit,
          balanceAfter: walletLock.depositBalance,
          idempotencyKey: `${keyPrefix}:deposit`,
        });
      }
      if (restoreCredit > 0) {
        walletLock.creditUsedAmount -= restoreCredit;
        await manager.save(WalletAccountEntity, walletLock);
        await manager.save(WalletTransactionEntity, {
          ...walletTxBase,
          resourceType: WalletResourceType.CREDIT,
          amount: -restoreCredit,
          balanceAfter: walletLock.creditUsedAmount,
          idempotencyKey: `${keyPrefix}:credit`,
        });
      }
      if (restoreExcess > 0) {
        walletLock.creditExcessAmount -= restoreExcess;
        await manager.save(WalletAccountEntity, walletLock);
        await manager.save(WalletTransactionEntity, {
          ...walletTxBase,
          resourceType: WalletResourceType.CREDIT_EXCESS,
          amount: -restoreExcess,
          balanceAfter: walletLock.creditExcessAmount,
          idempotencyKey: `${keyPrefix}:credit_excess`,
        });
      }
      if (restorablePoint > 0) {
        // grant remaining_amount 는 이미 2-1 단계에서 갱신됨. grant 별 wallet_transaction row split + balance_after 기록.
        for (const [grantId, info] of Object.entries(restoredByGrant)) {
          await manager.save(WalletTransactionEntity, {
            ...walletTxBase,
            resourceType: WalletResourceType.POINT,
            amount: info.amount,
            balanceAfter: info.balanceAfter,
            idempotencyKey: `${keyPrefix}:point:${grantId}`,
          });
        }
      }
      if (skippedPoint > 0) {
        // 만료 포인트 skip 도 audit row 남김 (plans/01_Wallet.md §8 RESTORE_SKIPPED_EXPIRED).
        await manager.save(WalletTransactionEntity, {
          ...walletTxBase,
          type: 'RESTORE_SKIPPED_EXPIRED',
          resourceType: WalletResourceType.POINT,
          amount: 0,
          balanceAfter: null,
          memo: `expired_point_skipped=${skippedPoint}`,
          idempotencyKey: `${keyPrefix}:point_skipped_expired`,
        });
      }

      // 3. ledger insert
      const ledger = await manager.save(OrderPaymentRefundEventEntity, {
        allocationId: alloc.id,
        orderId: input.orderId,
        eventType: input.eventType,
        affectedDeliveryIds: line.orderDeliveryId != null ? [line.orderDeliveryId] : [],
        refundedGrossBase: thisGrossBase,
        refundedPayableBase: thisPayableBase,
        refundedCardSurchargeAmount: thisSurcharge,
        refundedPointAmount: restorablePoint,
        refundedDepositAmount: restoreDeposit,
        refundedCreditUsedAmount: restoreCredit,
        refundedCreditExcessAmount: restoreExcess,
        pointSkippedExpiredAmount: skippedPoint,
        idempotencyKey: `${input.idempotencyKeyPrefix}:line:${line.id}`,
        reversedAt: null,
        reversedByWalletTransactionId: null,
      });
      ledgers.push(ledger);
      pointRestoredTotal += restorablePoint;
      pointSkippedTotal += skippedPoint;
      activePayableSum += thisPayableBase;
    }

    // allocation 누적 갱신
    alloc.pointRestoredAmount = pointRestoredTotal;
    alloc.creditExcessRestoredAmount = creditExcessRestoredTotal;
    alloc.creditUsedRestoredAmount = creditUsedRestoredTotal;
    alloc.depositRestoredAmount = depositRestoredTotal;
    alloc.pointSkippedExpiredAmount = pointSkippedTotal;
    await manager.save(OrderPaymentAllocationEntity, alloc);

    return this.buildRefundResult(ledgers, false);
  }

  private async runRefundFromResendDeductTransactions(
    input: RefundEventInput,
    alloc: OrderPaymentAllocationEntity,
    walletLock: WalletAccountEntity,
    manager: EntityManager,
  ): Promise<RefundEventResult> {
    if (!input.attemptId) {
      throw new BadRequestException('refundFromAttemptTransactions requires attemptId');
    }
    if (input.targetDeliveryIds.length !== 1) {
      throw new BadRequestException('refundFromAttemptTransactions supports one delivery per attempt refund');
    }
    const orderDeliveryId = input.targetDeliveryIds[0];
    const keyPrefix = `resend_deduct:${input.orderId}:${orderDeliveryId}:`;
    const attemptSuffix = `:${input.attemptId}`;
    const resendDeductTxs = await manager
      .getRepository(WalletTransactionEntity)
      .createQueryBuilder('tx')
      .where('tx.orderId = :orderId', { orderId: input.orderId })
      .andWhere('tx.orderDeliveryId = :orderDeliveryId', { orderDeliveryId })
      .andWhere('tx.type = :type', { type: 'RESEND_DEDUCT' })
      .andWhere('tx.idempotencyKey LIKE :prefix', { prefix: `${keyPrefix}%` })
      .getMany();
    const attemptTxs = resendDeductTxs.filter((tx) => (tx.idempotencyKey ?? '').endsWith(attemptSuffix));
    if (attemptTxs.length === 0) {
      throw new BadRequestException(
        `RESEND_DEDUCT transaction not found for orderId=${input.orderId}, deliveryId=${orderDeliveryId}, attemptId=${input.attemptId}`,
      );
    }

    let refundPoint = 0;
    let skippedPoint = 0;
    let refundDeposit = 0;
    let refundCredit = 0;
    let refundExcess = 0;
    const pointByGrant: Record<string, number> = {};
    for (const tx of attemptTxs) {
      const amount = Math.abs(tx.amount);
      if (tx.resourceType === WalletResourceType.POINT) {
        refundPoint += amount;
        const parsed = this.parseResendPointGrantId(tx, input.attemptId);
        pointByGrant[parsed.grantId] = (pointByGrant[parsed.grantId] ?? 0) + amount;
      } else if (tx.resourceType === WalletResourceType.DEPOSIT) {
        refundDeposit += amount;
      } else if (tx.resourceType === WalletResourceType.CREDIT) {
        refundCredit += amount;
      } else if (tx.resourceType === WalletResourceType.CREDIT_EXCESS) {
        refundExcess += amount;
      }
    }

    const totalAttemptRefund = refundPoint + refundDeposit + refundCredit + refundExcess;
    if (totalAttemptRefund <= 0) {
      throw new BadRequestException(
        `RESEND_DEDUCT refund amount is zero for orderId=${input.orderId}, deliveryId=${orderDeliveryId}, attemptId=${input.attemptId}`,
      );
    }

    if (refundDeposit > 0) {
      walletLock.depositBalance += refundDeposit;
      await manager.save(WalletAccountEntity, walletLock);
      await manager.save(WalletTransactionEntity, {
        walletAccountId: alloc.walletAccountId,
        orderId: input.orderId,
        orderDeliveryId,
        type: input.eventType.toUpperCase(),
        resourceType: WalletResourceType.DEPOSIT,
        amount: refundDeposit,
        balanceAfter: walletLock.depositBalance,
        memo: `refund_from_resend_deduct attempt=${input.attemptId}`,
        idempotencyKey: `${input.idempotencyKeyPrefix}:attempt:${orderDeliveryId}:deposit`,
      });
    }
    for (const [grantId, amount] of Object.entries(pointByGrant)) {
      const grant = await manager.findOne(PointGrantEntity, { where: { id: grantId } });
      const expired = grant?.expiresAt != null && grant.expiresAt < new Date();
      const usages = await manager.find(OrderPointUsageEntity, {
        where: { allocationId: alloc.id, pointGrantId: grantId },
        order: { id: 'ASC' },
      });
      let remaining = amount;
      for (const usage of usages) {
        if (remaining <= 0) break;
        const usageRemaining = usage.usedAmount - usage.restoredAmount - usage.skippedExpiredAmount;
        const portion = Math.min(remaining, usageRemaining);
        if (portion <= 0) continue;
        if (expired) {
          usage.skippedExpiredAmount += portion;
        } else {
          usage.restoredAmount += portion;
        }
        await manager.save(OrderPointUsageEntity, usage);
        remaining -= portion;
      }
      if (remaining > 0) {
        throw new BadRequestException(
          `POINT RESEND_DEDUCT usage restore insufficient (grantId=${grantId}, remaining=${remaining}, attemptId=${input.attemptId})`,
        );
      }
      if (expired) {
        skippedPoint += amount;
        continue;
      }
      const upd = await manager
        .createQueryBuilder()
        .update(PointGrantEntity)
        .set({ remainingAmount: () => `remaining_amount + ${amount}` })
        .where('id = :id AND active = 1', { id: grantId, portion: amount })
        .execute();
      if (upd.affected !== 1) {
        throw new BadRequestException(
          `POINT RESEND_DEDUCT grant restore conflict (grantId=${grantId}, amount=${amount}, attemptId=${input.attemptId})`,
        );
      }
      const refreshed = await manager.findOne(PointGrantEntity, { where: { id: grantId } });
      await manager.save(WalletTransactionEntity, {
        walletAccountId: alloc.walletAccountId,
        orderId: input.orderId,
        orderDeliveryId,
        type: input.eventType.toUpperCase(),
        resourceType: WalletResourceType.POINT,
        amount,
        balanceAfter: refreshed?.remainingAmount ?? null,
        memo: `refund_from_resend_deduct point grant=${grantId} attempt=${input.attemptId}`,
        idempotencyKey: `${input.idempotencyKeyPrefix}:attempt:${orderDeliveryId}:point:${grantId}`,
      });
    }
    if (skippedPoint > 0) {
      await manager.save(WalletTransactionEntity, {
        walletAccountId: alloc.walletAccountId,
        orderId: input.orderId,
        orderDeliveryId,
        type: 'RESTORE_SKIPPED_EXPIRED',
        resourceType: WalletResourceType.POINT,
        amount: 0,
        balanceAfter: null,
        memo: `expired_point_skipped=${skippedPoint}`,
        idempotencyKey: `${input.idempotencyKeyPrefix}:attempt:${orderDeliveryId}:point_skipped_expired`,
      });
    }
    if (refundCredit > 0) {
      walletLock.creditUsedAmount -= refundCredit;
      await manager.save(WalletAccountEntity, walletLock);
      await manager.save(WalletTransactionEntity, {
        walletAccountId: alloc.walletAccountId,
        orderId: input.orderId,
        orderDeliveryId,
        type: input.eventType.toUpperCase(),
        resourceType: WalletResourceType.CREDIT,
        amount: -refundCredit,
        balanceAfter: walletLock.creditUsedAmount,
        memo: `refund_from_resend_deduct attempt=${input.attemptId}`,
        idempotencyKey: `${input.idempotencyKeyPrefix}:attempt:${orderDeliveryId}:credit`,
      });
    }
    if (refundExcess > 0) {
      walletLock.creditExcessAmount -= refundExcess;
      await manager.save(WalletAccountEntity, walletLock);
      await manager.save(WalletTransactionEntity, {
        walletAccountId: alloc.walletAccountId,
        orderId: input.orderId,
        orderDeliveryId,
        type: input.eventType.toUpperCase(),
        resourceType: WalletResourceType.CREDIT_EXCESS,
        amount: -refundExcess,
        balanceAfter: walletLock.creditExcessAmount,
        memo: `refund_from_resend_deduct attempt=${input.attemptId}`,
        idempotencyKey: `${input.idempotencyKeyPrefix}:attempt:${orderDeliveryId}:credit_excess`,
      });
    }

    const restoredPoint = refundPoint - skippedPoint;
    const refundedPayable = restoredPoint + refundDeposit + refundCredit + refundExcess;
    alloc.pointRestoredAmount += restoredPoint;
    alloc.pointSkippedExpiredAmount += skippedPoint;
    alloc.depositRestoredAmount += refundDeposit;
    alloc.creditUsedRestoredAmount += refundCredit;
    alloc.creditExcessRestoredAmount += refundExcess;
    await manager.save(OrderPaymentAllocationEntity, alloc);

    const ledger = await manager.save(OrderPaymentRefundEventEntity, {
      allocationId: alloc.id,
      orderId: input.orderId,
      eventType: input.eventType,
      affectedDeliveryIds: [orderDeliveryId],
      refundedGrossBase: totalAttemptRefund,
      refundedPayableBase: refundedPayable,
      refundedCardSurchargeAmount: 0,
      refundedPointAmount: restoredPoint,
      refundedDepositAmount: refundDeposit,
      refundedCreditUsedAmount: refundCredit,
      refundedCreditExcessAmount: refundExcess,
      pointSkippedExpiredAmount: skippedPoint,
      idempotencyKey: `${input.idempotencyKeyPrefix}:attempt:${orderDeliveryId}`,
      reversedAt: null,
      reversedByWalletTransactionId: null,
    });

    return this.buildRefundResult([ledger], false);
  }

  private availableResourceAmount(resource: WalletResourceType, used: number, restored: number): number {
    const available = used - restored;
    if (used < 0 || restored < 0 || available < 0) {
      throw new BadRequestException(
        `refund resource counter drift: resource=${resource}, used=${used}, restored=${restored}`,
      );
    }
    return available;
  }
  private buildRefundResult(events: OrderPaymentRefundEventEntity[], alreadyRefunded: boolean): RefundEventResult {
    const totals = events.reduce(
      (result, event) => ({
        refundedPointAmount: result.refundedPointAmount + event.refundedPointAmount,
        refundedDepositAmount: result.refundedDepositAmount + event.refundedDepositAmount,
        refundedCreditUsedAmount: result.refundedCreditUsedAmount + event.refundedCreditUsedAmount,
        refundedCreditExcessAmount: result.refundedCreditExcessAmount + event.refundedCreditExcessAmount,
        pointSkippedExpiredAmount: result.pointSkippedExpiredAmount + event.pointSkippedExpiredAmount,
      }),
      {
        refundedPointAmount: 0,
        refundedDepositAmount: 0,
        refundedCreditUsedAmount: 0,
        refundedCreditExcessAmount: 0,
        pointSkippedExpiredAmount: 0,
      },
    );
    return {
      ledgerIds: events.map((event) => event.id),
      totalRefundedAmount:
        totals.refundedPointAmount +
        totals.refundedDepositAmount +
        totals.refundedCreditUsedAmount +
        totals.refundedCreditExcessAmount,
      ...totals,
      alreadyRefunded,
    };
  }

  private parseResendPointGrantId(tx: WalletTransactionEntity, attemptId: string): { grantId: string } {
    const parts = (tx.idempotencyKey ?? '').split(':');
    // resend_deduct:{orderId}:{deliveryId}:point:{grantId}:{attemptId}
    if (
      parts.length < 6 ||
      parts[0] !== 'resend_deduct' ||
      parts[3] !== 'point' ||
      parts[parts.length - 1] !== attemptId
    ) {
      throw new BadRequestException(
        `POINT RESEND_DEDUCT idempotencyKey is missing grant source (txId=${tx.id}, attemptId=${attemptId})`,
      );
    }
    const grantId = parts.slice(4, -1).join(':');
    if (!grantId) {
      throw new BadRequestException(
        `POINT RESEND_DEDUCT idempotencyKey has empty grant source (txId=${tx.id}, attemptId=${attemptId})`,
      );
    }
    return { grantId };
  }

  /**
   * 재발송 역환불 (Cross-Cutting Invariants §8 재발송 역환불).
   *
   * caller (재발송 흐름 TX1) 가 호출: ledger row 의 reversed_at 갱신 + allocation counters 복원.
   * wallet_account 잔액 재차감은 호출자가 ResendDeductService.resendDeduct 로 별도 처리.
   *
   * 멱등: ledger.reversed_at 이미 set → no-op return (정상).
   * 사양: ledger 금액 그대로 사용 — 재계산 금지.
   */
  async reverseRefund(
    ledgerId: string,
    reversedByWalletTransactionId: string,
    externalManager?: EntityManager,
  ): Promise<{ alreadyReversed: boolean; ledgerId: string }> {
    if (externalManager) {
      return this.runReverseRefund(ledgerId, reversedByWalletTransactionId, externalManager);
    }
    return this.dataSource.transaction(async (m) => this.runReverseRefund(ledgerId, reversedByWalletTransactionId, m));
  }

  private async runReverseRefund(
    ledgerId: string,
    reversedByWalletTransactionId: string,
    manager: EntityManager,
  ): Promise<{ alreadyReversed: boolean; ledgerId: string }> {
    const ledger = await manager
      .getRepository(OrderPaymentRefundEventEntity)
      .createQueryBuilder('e')
      .setLock('pessimistic_write')
      .where('e.id = :id', { id: ledgerId })
      .getOne();
    if (!ledger) {
      throw new BadRequestException(`reverseRefund: ledger not found id=${ledgerId}`);
    }
    if (ledger.reversedAt != null) {
      return { alreadyReversed: true, ledgerId };
    }

    const alloc = await manager
      .getRepository(OrderPaymentAllocationEntity)
      .createQueryBuilder('a')
      .setLock('pessimistic_write')
      .where('a.id = :id', { id: ledger.allocationId })
      .getOne();
    if (!alloc) {
      throw new BadRequestException(`reverseRefund: allocation not found id=${ledger.allocationId}`);
    }

    // allocation counters 복원 (ledger 금액 그대로 — 재계산 금지).
    // counter < ledger 금액이면 invariant 위반(복구 누적이 ledger 보다 작음) = data drift.
    // 0 으로 조용히 clamp 하면 같은 포인트/금액이 2번 복구될 수 있어, fail-fast 로 노출한다.
    const subtractRestored = (label: string, current: number, delta: number): number => {
      if (current < delta) {
        throw new Error(
          `reverseRefund invariant 위반: ${label} ${current} < ledger ${delta} (ledgerId=${ledgerId}). data drift — 수동 점검 필요.`,
        );
      }
      return current - delta;
    };
    alloc.pointRestoredAmount = subtractRestored(
      'pointRestored',
      alloc.pointRestoredAmount,
      ledger.refundedPointAmount,
    );
    alloc.creditExcessRestoredAmount = subtractRestored(
      'creditExcessRestored',
      alloc.creditExcessRestoredAmount,
      ledger.refundedCreditExcessAmount,
    );
    alloc.creditUsedRestoredAmount = subtractRestored(
      'creditUsedRestored',
      alloc.creditUsedRestoredAmount,
      ledger.refundedCreditUsedAmount,
    );
    alloc.depositRestoredAmount = subtractRestored(
      'depositRestored',
      alloc.depositRestoredAmount,
      ledger.refundedDepositAmount,
    );
    alloc.pointSkippedExpiredAmount = subtractRestored(
      'pointSkippedExpired',
      alloc.pointSkippedExpiredAmount,
      ledger.pointSkippedExpiredAmount,
    );
    await manager.save(OrderPaymentAllocationEntity, alloc);

    // POINT 대칭 역복구 (HIGH2). alloc 카운터는 위에서 차감됨. 여기서 grant/usage/wallet_tx 를 forward 의
    // 정확한 역연산으로 되돌린다 — 그래야 재발송 후 다음 재실패 refund 가 skip 을 깨끗이 재도출한다.
    await this.reversePointRestored(ledger, alloc, reversedByWalletTransactionId, manager);
    await this.reversePointSkipped(ledger, alloc, reversedByWalletTransactionId, manager);

    // ledger 표시
    ledger.reversedAt = new Date();
    ledger.reversedByWalletTransactionId = reversedByWalletTransactionId;
    await manager.save(OrderPaymentRefundEventEntity, ledger);

    return { alreadyReversed: false, ledgerId };
  }

  /**
   * restored point 역복구 (per-grant). forward 가 남긴 POINT wallet_transaction(grant별 양수 row)에서
   * grant 별 portion 을 재구성해 point_grant.remaining 재차감 + order_point_usage.restored 역복구 +
   * POINT 역행 wallet_transaction(resend_deduct cycle) 기록.
   *
   * 소스 = wallet_tx (ledger 엔 aggregate refundedPointAmount 만, per-grant 분해 없음).
   *   key = `${ledger.idempotencyKey}:point:${grantId}` (refund() :319). _ / % 는 LIKE wildcard 라 escape.
   * (allocation, point_grant) 는 unique 가 없어 usage 가 라인별 다중행일 수 있다 → id ASC greedy 분배.
   */
  private async reversePointRestored(
    ledger: OrderPaymentRefundEventEntity,
    alloc: OrderPaymentAllocationEntity,
    reversedByWalletTransactionId: string,
    manager: EntityManager,
  ): Promise<void> {
    if (ledger.refundedPointAmount <= 0) return;
    const deliveryId = ledger.affectedDeliveryIds?.[0] ?? null;

    const escapeLike = (s: string) => s.replace(/([\\%_])/g, '\\$1');
    const rows = await manager
      .getRepository(WalletTransactionEntity)
      .createQueryBuilder('t')
      .where('t.orderId = :orderId', { orderId: ledger.orderId })
      .andWhere('t.orderDeliveryId = :did', { did: deliveryId })
      .andWhere('t.resourceType = :rt', { rt: WalletResourceType.POINT })
      .andWhere('t.amount > 0') // 역행/skip(amount<=0) 제외
      .andWhere("t.idempotencyKey LIKE :pat ESCAPE '\\\\'", {
        pat: `${escapeLike(ledger.idempotencyKey)}:point:%`,
      })
      .getMany();

    const prefix = `${ledger.idempotencyKey}:point:`;
    let reconstructed = 0;
    for (const tx of rows) {
      const grantId = tx.idempotencyKey.slice(prefix.length);
      const portion = tx.amount; // amount > 0 필터는 getMany WHERE 절에서 이미 보장됨
      reconstructed += portion;

      // 1) point_grant.remaining_amount -= portion (조건부 UPDATE). forward :220-228 대칭.
      //    active=0 또는 remaining<portion 이면 affected!=1 → fail-fast (음수/이중역복구/drift 노출).
      const upd = await manager
        .createQueryBuilder()
        .update(PointGrantEntity)
        .set({ remainingAmount: () => `remaining_amount - ${portion}` })
        .where('id = :id AND active = 1 AND remaining_amount >= :portion', { id: grantId, portion })
        .execute();
      if (upd.affected !== 1) {
        throw new Error(
          `reverseRefund POINT 역복구 conflict (grantId=${grantId}, portion=${portion}, ledgerId=${ledger.id}). ` +
            `active=0 또는 remaining<portion — drift, 수동 점검 필요.`,
        );
      }
      const refreshed = await manager.findOne(PointGrantEntity, { where: { id: grantId } });

      // 2) order_point_usage.restored_amount -= portion. (allocation, grant) 다중행 → id ASC greedy.
      const usages = await manager.find(OrderPointUsageEntity, {
        where: { allocationId: alloc.id, pointGrantId: grantId },
        order: { id: 'ASC' },
      });
      let remaining = portion;
      for (const u of usages) {
        if (remaining <= 0) break;
        const dec = Math.min(remaining, u.restoredAmount);
        if (dec <= 0) continue;
        u.restoredAmount -= dec;
        await manager.save(OrderPointUsageEntity, u);
        remaining -= dec;
      }
      if (remaining > 0) {
        throw new Error(
          `reverseRefund POINT usage 역복구 부족 (grantId=${grantId}, 남은 ${remaining}/${portion}, ledgerId=${ledger.id}). ` +
            `Σ usage.restored < portion — drift.`,
        );
      }

      // 3) POINT 역행 wallet_transaction 1행 (resendDeduct deposit/credit/excess 와 동일 cycle/type).
      await manager.save(WalletTransactionEntity, {
        walletAccountId: alloc.walletAccountId,
        orderId: ledger.orderId,
        orderDeliveryId: deliveryId,
        type: 'RESEND_DEDUCT',
        resourceType: WalletResourceType.POINT,
        amount: -portion,
        balanceAfter: refreshed?.remainingAmount ?? null,
        memo: `resend_deduct point reverse grant=${grantId}`,
        idempotencyKey: `resend_deduct:${ledger.orderId}:${deliveryId}:point:${grantId}:${reversedByWalletTransactionId}`,
      });
    }

    if (reconstructed !== ledger.refundedPointAmount) {
      throw new Error(
        `reverseRefund POINT 재구성 합계 불일치 (Σ ${reconstructed} !== ledger.refundedPointAmount ` +
          `${ledger.refundedPointAmount}, ledgerId=${ledger.id}). wallet_tx 재구성 누락/중복 — drift.`,
      );
    }
  }

  /**
   * skipped-expired point 역복구. forward 는 만료 grant 마다 usage.skipped + alloc.skipped 를 동시에 올린다.
   * reverse 가 alloc 만 내리면 usageRemaining = used - restored - skipped 가 영구 understate 되어, 재발송으로
   * deduction 이 복원됐는데도 만료분이 "해소됨"으로 남아 다음 재실패 refund 가 포인트 대신 deposit/credit 을
   * 환불하거나 invariant 가 깨진다. resend = 원 deduction 복원 → usageRemaining 은 used 로 복귀해야 한다.
   *
   * skip wallet_tx 는 line 당 1행 amount=0 memo total 뿐이라 grant/usage 분해가 없다 → grant scope 불가.
   * allocation usage 중 skippedExpiredAmount>0 행에 합계(ledger.pointSkippedExpiredAmount)를 id ASC greedy 분배.
   * (alloc.pointSkippedExpiredAmount 차감은 runReverseRefund 의 subtractRestored 에서 이미 처리됨.)
   */
  private async reversePointSkipped(
    ledger: OrderPaymentRefundEventEntity,
    alloc: OrderPaymentAllocationEntity,
    reversedByWalletTransactionId: string,
    manager: EntityManager,
  ): Promise<void> {
    const skipped = ledger.pointSkippedExpiredAmount;
    if (skipped <= 0) return;
    const deliveryId = ledger.affectedDeliveryIds?.[0] ?? null;

    const usages = await manager.find(OrderPointUsageEntity, {
      where: { allocationId: alloc.id },
      order: { id: 'ASC' },
    });
    let remaining = skipped;
    for (const u of usages) {
      if (remaining <= 0) break;
      const dec = Math.min(remaining, u.skippedExpiredAmount);
      if (dec <= 0) continue;
      u.skippedExpiredAmount -= dec;
      await manager.save(OrderPointUsageEntity, u);
      remaining -= dec;
    }
    if (remaining > 0) {
      throw new Error(
        `reverseRefund POINT skip 역복구 부족 (남은 ${remaining}/${skipped}, ledgerId=${ledger.id}). ` +
          `Σ usage.skipped < ledger — drift.`,
      );
    }

    // audit row (forward refund() :323-333 parity). amount=0, balance 무영향.
    await manager.save(WalletTransactionEntity, {
      walletAccountId: alloc.walletAccountId,
      orderId: ledger.orderId,
      orderDeliveryId: deliveryId,
      type: 'RESEND_DEDUCT',
      resourceType: WalletResourceType.POINT,
      amount: 0,
      balanceAfter: null,
      memo: `expired_point_reskip=${skipped}`,
      idempotencyKey: `resend_deduct:${ledger.orderId}:${deliveryId}:point_skipped_expired:${reversedByWalletTransactionId}`,
    });
  }
  /** H1: 정산코드 이동 후 역처리 차단 — allocation wallet owner 가 billing user 현재 code 와 다르면 throw. */
  private async assertReversalCodeNotMoved(
    manager: EntityManager,
    orderId: number,
    walletOwnerId: string,
  ): Promise<void> {
    const order = await manager.findOne(OrderEntity, {
      where: { id: orderId },
      select: ['id', 'userId', 'clientUserId'],
    });
    if (!order) {
      throw new BadRequestException(`RefundPoolService: order not found id=${orderId}`);
    }
    await assertAllocationCodeNotMoved(manager, order, walletOwnerId);
  }
}
