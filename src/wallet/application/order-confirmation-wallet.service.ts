import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { OrderPaymentAllocationLineEntity } from '../../entity/order.payment.allocation.line.entity';
import { OrderPointUsageEntity } from '../../entity/order.point.usage.entity';
import {
  OrderDeliveryAttemptEntity,
  OrderDeliveryAttemptType,
  OrderDeliveryAttemptStatus,
} from '../../entity/order.delivery.attempt.entity';
import { AllocationResult } from './payment-allocation.service';
import { WalletLedgerService } from './wallet-ledger.service';
import { WalletResourceType } from '../interface/wallet-resource-type';

export interface PersistAllocationInput {
  orderId: number;
  allocation: AllocationResult;
  pointUsages: Array<{
    orderDeliveryId: number | null;
    pointGrantId: string;
    usedAmount: number;
    expiresAtSnapshot: Date | null;
  }>;
  cardSurchargeAppliedSnapshot: boolean;
  hasDiscountSnapshot: boolean;
  settleMethodSnapshot: string | null;
  deliveryIdsForAttempt: number[]; // 최초 발송 attempt row 발급 대상
}

export interface PersistAllocationResult {
  allocationId: string;
  lineIds: string[];
  attemptIds: string[]; // 발송확정 시점 INITIAL attempt row PK 들
  walletTransactionIds: string[];
}

/**
 * 발송확정 트랜잭션 통합 orchestrator (Cross-Cutting Invariants §4).
 *
 * 호출 순서 (호출자 트랜잭션 안):
 *   1. PaymentAllocationService.allocate() (외부 호출자가 미리 수행)
 *   2. this.persistAllocation(): allocation/line/point_usage/attempt insert + wallet_account 잔액 갱신 + wallet_transaction 저장
 *   3. (트랜잭션 밖) SSG / external API 호출
 *   4. 외부 호출 실패 시 호출자가 별도 보상 트랜잭션 (confirm_release) 수행
 *
 * legacy field (order.settleAmount / isSettleBalance / isCreditExcess / user.balance) 병행 갱신은 호출자가 같은 트랜잭션 안에서 수행한다 (PR2 phase A).
 */
@Injectable()
export class OrderConfirmationWalletService {
  private readonly logger = new Logger(OrderConfirmationWalletService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: WalletLedgerService,
  ) {}

  async persistAllocation(input: PersistAllocationInput): Promise<PersistAllocationResult> {
    return this.dataSource.transaction(async (manager) => {
      // 1. allocation row
      const alloc = await manager.save(OrderPaymentAllocationEntity, {
        orderId: input.orderId,
        walletAccountId: input.allocation.walletAccountId,
        grossSettlementAmount: input.allocation.grossSettlementAmount,
        pointUsedAmount: input.allocation.pointUsedAmount,
        payableSettlementAmount: input.allocation.payableSettlementAmount,
        depositUsedAmount: input.allocation.depositUsedAmount,
        creditUsedAmount: input.allocation.creditUsedAmount,
        creditExcessAmount: input.allocation.creditExcessAmount,
        cardSurchargeAmount: input.allocation.cardSurchargeAmount,
        cardSurchargeApplied: input.cardSurchargeAppliedSnapshot ? 1 : 0,
        hasDiscount: input.hasDiscountSnapshot ? 1 : 0,
        settleMethodSnapshot: input.settleMethodSnapshot,
      });

      // 2. lines
      const lineIds: string[] = [];
      for (const line of input.allocation.lines) {
        const saved = await manager.save(OrderPaymentAllocationLineEntity, {
          allocationId: alloc.id,
          orderId: input.orderId,
          orderProductMappingId: line.orderProductMappingId,
          orderDeliveryId: line.orderDeliveryId,
          orderType: 'GENERAL',
          grossSettlementAmount: line.grossSettlementAmount,
          appliedFeePercent: line.appliedFeePercent,
          appliedPriceAdjustment: line.appliedPriceAdjustment,
          pointUsedAmount: line.pointUsedAmount,
          payableBase: line.payableBase,
          depositUsedAmount: line.depositUsedAmount,
          creditUsedAmount: line.creditUsedAmount,
          creditExcessAmount: line.creditExcessAmount,
        });
        lineIds.push(saved.id);
      }

      // 3. point_usage
      for (const usage of input.pointUsages) {
        await manager.save(OrderPointUsageEntity, {
          allocationId: alloc.id,
          orderId: input.orderId,
          orderDeliveryId: usage.orderDeliveryId,
          pointGrantId: usage.pointGrantId,
          usedAmount: usage.usedAmount,
          restoredAmount: 0,
          skippedExpiredAmount: 0,
          expiresAtSnapshot: usage.expiresAtSnapshot,
        });
      }

      // 4. attempt row (INITIAL) per delivery
      const attemptIds: string[] = [];
      for (const deliveryId of input.deliveryIdsForAttempt) {
        const attempt = await manager.save(OrderDeliveryAttemptEntity, {
          orderDeliveryId: deliveryId,
          attemptType: OrderDeliveryAttemptType.INITIAL,
          status: OrderDeliveryAttemptStatus.DEDUCTED,
          deductedAt: new Date(),
        });
        attemptIds.push(attempt.id);
      }

      // 5. wallet_transaction row split per resource
      const walletTxIds: string[] = [];
      const records: Array<{ resource: WalletResourceType; amount: number; suffix: string; grantId?: string }> = [];
      if (input.allocation.depositUsedAmount > 0) {
        records.push({
          resource: WalletResourceType.DEPOSIT,
          amount: -input.allocation.depositUsedAmount,
          suffix: 'deposit',
        });
      }
      if (input.allocation.creditUsedAmount > 0) {
        records.push({
          resource: WalletResourceType.CREDIT,
          amount: input.allocation.creditUsedAmount,
          suffix: 'credit',
        });
      }
      if (input.allocation.creditExcessAmount > 0) {
        records.push({
          resource: WalletResourceType.CREDIT_EXCESS,
          amount: input.allocation.creditExcessAmount,
          suffix: 'credit_excess',
        });
      }
      for (const usage of input.pointUsages) {
        if (usage.usedAmount > 0) {
          records.push({
            resource: WalletResourceType.POINT,
            amount: -usage.usedAmount,
            suffix: `point:${usage.pointGrantId}`,
            grantId: usage.pointGrantId,
          });
        }
      }

      for (const rec of records) {
        const r = await this.ledger.recordTransaction({
          walletAccountId: input.allocation.walletAccountId,
          orderId: input.orderId,
          type: 'CONFIRM',
          resourceType: rec.resource,
          amount: rec.amount,
          pointGrantId: rec.grantId ?? null,
          idempotencyKey: `confirm:${input.orderId}::${rec.suffix}`,
        });
        if (r.transactionId) walletTxIds.push(r.transactionId);
      }

      return { allocationId: alloc.id, lineIds, attemptIds, walletTransactionIds: walletTxIds };
    });
  }
}
