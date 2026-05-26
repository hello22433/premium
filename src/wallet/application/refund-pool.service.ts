import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
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

export interface RefundEventInput {
  orderId: number;
  eventType: OrderPaymentRefundEventType;
  targetDeliveryIds: number[]; // 환불 대상 (라인 단위 ledger row 생성)
  idempotencyKeyPrefix: string; // ex) `fail_refund:${orderId}:${deliveryId}:${attempt_id}`
}

export interface RefundEventResult {
  ledgerIds: string[]; // 라인별 ledger row PK
  totalRefundedAmount: number;
}

/**
 * Cross-Cutting Invariants §8 환불 알고리즘 구현 (풀 기반 + ledger).
 *  - allocation FOR UPDATE row lock.
 *  - already_refunded 체크.
 *  - 라인 payable_base ASC 정렬 후 한 라인씩 ledger row 생성.
 *  - 자사 이득 우선순위: 포인트 → 신용초과 → 여신 → 예치금.
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

  async refund(input: RefundEventInput): Promise<RefundEventResult> {
    // READ COMMITTED 명시 — MySQL 기본 REPEATABLE READ 에서는 lock 획득 후 plain SELECT 가 트랜잭션 시작 시점의
    // consistent snapshot 을 보아 방금 다른 트랜잭션이 commit 한 refund ledger 를 못 볼 수 있다.
    // lock 후 same-prefix 재조회 (HIGH 2 fix) 가 의도대로 동작하려면 isolation 을 낮춰 current read 가 보이게 해야 한다.
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      // 0. retry idempotency: 동일 idempotencyKeyPrefix 으로 이미 ledger row 가 만들어졌으면 기존 결과 return.
      //    overlap 검사보다 먼저 — 같은 prefix retry 는 정상 처리됐던 결과를 BadRequest 가 아닌 200 으로 돌려야 worker 가 멈춤.
      const existingForPrefix = await manager
        .getRepository(OrderPaymentRefundEventEntity)
        .createQueryBuilder('e')
        .where('e.idempotencyKey LIKE :prefix', { prefix: `${input.idempotencyKeyPrefix}:line:%` })
        .getMany();
      if (existingForPrefix.length > 0) {
        const totalRefundedAmount = existingForPrefix.reduce(
          (s, e) => s + e.refundedGrossBase + e.refundedCardSurchargeAmount,
          0,
        );
        return { ledgerIds: existingForPrefix.map((e) => e.id), totalRefundedAmount };
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
        throw new BadRequestException(
          `allocation disappeared after peek (orderId=${input.orderId})`,
        );
      }

      // 0-b. lock 획득 후 same-prefix 재조회 — 동시 retry 2건 race 차단.
      //      첫 retry 가 lock 보유하면서 ledger 만들고 commit, 두 번째가 lock 받자마자 동일 prefix ledger 보면 success return.
      const existingAfterLock = await manager
        .getRepository(OrderPaymentRefundEventEntity)
        .createQueryBuilder('e')
        .where('e.idempotencyKey LIKE :prefix', { prefix: `${input.idempotencyKeyPrefix}:line:%` })
        .getMany();
      if (existingAfterLock.length > 0) {
        const totalRefundedAmount = existingAfterLock.reduce(
          (s, e) => s + e.refundedGrossBase + e.refundedCardSurchargeAmount,
          0,
        );
        return { ledgerIds: existingAfterLock.map((e) => e.id), totalRefundedAmount };
      }

      // already_refunded 체크 (different prefix — 진짜 중복 요청)
      const activeEvents = await manager.find(OrderPaymentRefundEventEntity, {
        where: { allocationId: alloc.id, reversedAt: IsNull() },
      });
      for (const ev of activeEvents) {
        const overlap = (ev.affectedDeliveryIds ?? []).some((d) => input.targetDeliveryIds.includes(d));
        if (overlap) {
          throw new BadRequestException('already_refunded');
        }
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

      const ledgerIds: string[] = [];
      let totalRefund = 0;
      let activeGrossSum = activeEvents.reduce((s, ev) => s + ev.refundedGrossBase, 0);
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
                throw new BadRequestException(
                  `point_grant restore conflict (id=${grant.id}, portion=${portion})`,
                );
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
        const excessAvail = alloc.creditExcessAmount - creditExcessRestoredTotal;
        const restoreExcess = Math.min(refundRemaining, excessAvail);
        creditExcessRestoredTotal += restoreExcess;
        refundRemaining -= restoreExcess;

        // 2-3 여신
        const creditAvail = alloc.creditUsedAmount - creditUsedRestoredTotal;
        const restoreCredit = Math.min(refundRemaining, creditAvail);
        creditUsedRestoredTotal += restoreCredit;
        refundRemaining -= restoreCredit;

        // 2-4 예치금
        const depositAvail = alloc.depositUsedAmount - depositRestoredTotal;
        const restoreDeposit = Math.min(refundRemaining, depositAvail);
        depositRestoredTotal += restoreDeposit;
        refundRemaining -= restoreDeposit;

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
        ledgerIds.push(ledger.id);
        pointRestoredTotal += restorablePoint;
        pointSkippedTotal += skippedPoint;
        activeGrossSum += thisGrossBase;
        activePayableSum += thisPayableBase;
        totalRefund += thisGrossBase + thisSurcharge;
      }

      // allocation 누적 갱신
      alloc.pointRestoredAmount = pointRestoredTotal;
      alloc.creditExcessRestoredAmount = creditExcessRestoredTotal;
      alloc.creditUsedRestoredAmount = creditUsedRestoredTotal;
      alloc.depositRestoredAmount = depositRestoredTotal;
      alloc.pointSkippedExpiredAmount = pointSkippedTotal;
      await manager.save(OrderPaymentAllocationEntity, alloc);

      return { ledgerIds, totalRefundedAmount: totalRefund };
    });
  }

  /**
   * 재발송 역환불 — PR1 scope 외. PR2 재발송 hook 작업에서 wallet/grant rollback + wallet_transaction row split 까지 함께 구현.
   * caller 없음 → stub throw 로 두어 실수로 호출되면 즉시 검출.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async reverseRefund(_ledgerId: string, _reversedByWalletTransactionId: string): Promise<void> {
    throw new BadRequestException('reverseRefund not implemented in PR1 — see PR2 resend hook');
  }
}
