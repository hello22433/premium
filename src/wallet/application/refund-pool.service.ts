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
    return this.dataSource.transaction(async (manager) => {
      const alloc = await manager
        .getRepository(OrderPaymentAllocationEntity)
        .createQueryBuilder('a')
        .setLock('pessimistic_write')
        .where('a.orderId = :orderId', { orderId: input.orderId })
        .getOne();
      if (!alloc) {
        throw new BadRequestException(`allocation not found for orderId=${input.orderId}`);
      }

      // already_refunded 체크
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

        // 2. 우선순위 풀 차감 복구
        // 2-1 포인트 (이 라인의 point_used_amount 한정 + 만료 grant skip)
        let restorablePoint = 0;
        let skippedPoint = 0;
        if (line.pointUsedAmount > 0 && refundRemaining > 0 && line.orderDeliveryId != null) {
          const usages = await manager.find(OrderPointUsageEntity, {
            where: { orderDeliveryId: line.orderDeliveryId, allocationId: alloc.id },
          });
          let pointToConsume = Math.min(refundRemaining, line.pointUsedAmount);
          for (const usage of usages) {
            if (pointToConsume <= 0) break;
            const grant = await manager.findOne(PointGrantEntity, { where: { id: usage.pointGrantId } });
            if (!grant) continue;
            const usageRemaining = usage.usedAmount - usage.restoredAmount - usage.skippedExpiredAmount;
            if (usageRemaining <= 0) continue;
            const portion = Math.min(pointToConsume, usageRemaining);
            const expired = grant.expiresAt != null && grant.expiresAt < new Date();
            if (expired) {
              skippedPoint += portion;
              usage.skippedExpiredAmount += portion;
            } else {
              restorablePoint += portion;
              usage.restoredAmount += portion;
              grant.remainingAmount += portion;
              await manager.save(PointGrantEntity, grant);
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

        if (restoreDeposit > 0) {
          const wallet = await manager
            .getRepository(WalletAccountEntity)
            .createQueryBuilder('w')
            .setLock('pessimistic_write')
            .where('w.id = :id', { id: alloc.walletAccountId })
            .getOne();
          if (wallet) {
            wallet.depositBalance += restoreDeposit;
            await manager.save(WalletAccountEntity, wallet);
            await manager.save(WalletTransactionEntity, {
              ...walletTxBase,
              resourceType: WalletResourceType.DEPOSIT,
              amount: restoreDeposit,
              balanceAfter: wallet.depositBalance,
              idempotencyKey: `${keyPrefix}:deposit`,
            });
          }
        }
        if (restoreCredit > 0) {
          const wallet = await manager
            .getRepository(WalletAccountEntity)
            .createQueryBuilder('w')
            .setLock('pessimistic_write')
            .where('w.id = :id', { id: alloc.walletAccountId })
            .getOne();
          if (wallet) {
            wallet.creditUsedAmount -= restoreCredit;
            await manager.save(WalletAccountEntity, wallet);
            await manager.save(WalletTransactionEntity, {
              ...walletTxBase,
              resourceType: WalletResourceType.CREDIT,
              amount: -restoreCredit,
              balanceAfter: wallet.creditUsedAmount,
              idempotencyKey: `${keyPrefix}:credit`,
            });
          }
        }
        if (restoreExcess > 0) {
          const wallet = await manager
            .getRepository(WalletAccountEntity)
            .createQueryBuilder('w')
            .setLock('pessimistic_write')
            .where('w.id = :id', { id: alloc.walletAccountId })
            .getOne();
          if (wallet) {
            wallet.creditExcessAmount -= restoreExcess;
            await manager.save(WalletAccountEntity, wallet);
            await manager.save(WalletTransactionEntity, {
              ...walletTxBase,
              resourceType: WalletResourceType.CREDIT_EXCESS,
              amount: -restoreExcess,
              balanceAfter: wallet.creditExcessAmount,
              idempotencyKey: `${keyPrefix}:credit_excess`,
            });
          }
        }
        if (restorablePoint > 0) {
          // grant remaining_amount 는 이미 2-1 단계에서 갱신됨. wallet_transaction 만 audit log 로 insert.
          await manager.save(WalletTransactionEntity, {
            ...walletTxBase,
            resourceType: WalletResourceType.POINT,
            amount: restorablePoint,
            balanceAfter: null,
            idempotencyKey: `${keyPrefix}:point`,
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

  /** 재발송 역환불: 기존 ledger 금액 그대로 차감 복구 (재계산 금지). */
  async reverseRefund(ledgerId: string, reversedByWalletTransactionId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const ledger = await manager
        .getRepository(OrderPaymentRefundEventEntity)
        .createQueryBuilder('l')
        .setLock('pessimistic_write')
        .where('l.id = :id AND l.reversedAt IS NULL', { id: ledgerId })
        .getOne();
      if (!ledger) {
        throw new BadRequestException(`ledger not found or already reversed: ${ledgerId}`);
      }
      const alloc = await manager.findOne(OrderPaymentAllocationEntity, { where: { id: ledger.allocationId } });
      if (!alloc) throw new BadRequestException('allocation missing');

      alloc.pointRestoredAmount -= ledger.refundedPointAmount;
      alloc.creditExcessRestoredAmount -= ledger.refundedCreditExcessAmount;
      alloc.creditUsedRestoredAmount -= ledger.refundedCreditUsedAmount;
      alloc.depositRestoredAmount -= ledger.refundedDepositAmount;
      alloc.pointSkippedExpiredAmount -= ledger.pointSkippedExpiredAmount;
      await manager.save(OrderPaymentAllocationEntity, alloc);

      ledger.reversedAt = new Date();
      ledger.reversedByWalletTransactionId = reversedByWalletTransactionId;
      await manager.save(OrderPaymentRefundEventEntity, ledger);
    });
  }
}
