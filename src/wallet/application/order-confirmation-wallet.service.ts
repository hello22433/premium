import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { OrderPaymentAllocationLineEntity } from '../../entity/order.payment.allocation.line.entity';
import { OrderPointUsageEntity } from '../../entity/order.point.usage.entity';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import {
  OrderDeliveryAttemptEntity,
  OrderDeliveryAttemptType,
  OrderDeliveryAttemptStatus,
} from '../../entity/order.delivery.attempt.entity';
import { AllocationResult } from './payment-allocation.service';
import { WalletLedgerService } from './wallet-ledger.service';
import { CreditExcessApprovalService } from './credit-excess-approval.service';
import { CreditExcessApprovalRequiredError } from './credit-excess-approval-required.error';
import { WalletResourceType } from '../interface/wallet-resource-type';

export interface PersistAllocationInput {
  orderId: number;
  allocation: AllocationResult; // allocation.pointUsages 사용 — 별도 pointUsages 입력 불필요
  cardSurchargeAppliedSnapshot: boolean;
  hasDiscountSnapshot: boolean;
  settleMethodSnapshot: string | null;
  deliveryIdsForAttempt: number[];
  /**
   * 신용초과 사용분 발생 시 사전 승인된 approval id 필수.
   * persistAllocation 안에서 same-tx 로 consume() 호출 → wallet credit_excess 기록과 원자성 보장.
   */
  creditExcessApprovalId?: string | null;
}

export interface PersistAllocationResult {
  allocationId: string;
  lineIds: string[];
  attemptIds: string[];
  walletTransactionIds: string[];
  /**
   * lock 이후 wallet 잔여 기준으로 재계산된 최종 allocation (deposit/credit/excess 재분배 반영).
   * 호출자는 응답/legacy mirror 에 *반드시 이 값* 을 써야 한다. 입력 allocation(pre-lock)은
   * 동시 주문으로 stale 일 수 있어 persisted state 와 어긋난다.
   */
  finalAllocation: AllocationResult;
}

/**
 * 발송확정 트랜잭션 통합 orchestrator.
 *
 * 단일 트랜잭션 안에서:
 *   1. wallet_account FOR UPDATE (race 차단)
 *   2. 한도 invariant 재검증 (stale allocation drift 차단)
 *   3. allocation/line/point_usage/attempt insert
 *   4. wallet_transaction row split (same manager 사용, nested tx X)
 *
 * invariant 위반 시 BadRequestException throw → 호출자 재계산 후 재호출.
 */
@Injectable()
export class OrderConfirmationWalletService {
  private readonly logger = new Logger(OrderConfirmationWalletService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: WalletLedgerService,
    private readonly creditExcessApproval: CreditExcessApprovalService,
  ) {}

  /**
   * 발송확정 통합 orchestrator.
   *
   * @param input allocation/snapshot 입력
   * @param externalManager 호출자가 같은 트랜잭션 안에서 legacy mirror 와 함께 묶고 싶을 때 전달.
   *   - 미전달 시 자체 트랜잭션 열음 (PR1 호환).
   *   - 전달 시 nested transaction 없이 이 manager 위에서 실행 (PR2 hook same-tx 보장).
   */
  async persistAllocation(
    input: PersistAllocationInput,
    externalManager?: EntityManager,
  ): Promise<PersistAllocationResult> {
    if (externalManager) {
      return this.runOnManager(input, externalManager);
    }
    return this.dataSource.transaction(async (manager) => this.runOnManager(input, manager));
  }

  private async runOnManager(input: PersistAllocationInput, manager: EntityManager): Promise<PersistAllocationResult> {
    // legacy 안내: 본 body 는 기존 transaction callback 의 코드를 그대로 사용.
    // externalManager 전달 시 nested tx 회피 + same-tx mirror 보장.
    return this.persistAllocationInTx(input, manager);
  }

  private async persistAllocationInTx(
    input: PersistAllocationInput,
    manager: EntityManager,
  ): Promise<PersistAllocationResult> {
      // 1. wallet FOR UPDATE — race 차단 + 잔액 재검증
      const wallet = await manager
        .getRepository(WalletAccountEntity)
        .createQueryBuilder('w')
        .setLock('pessimistic_write')
        .where('w.id = :id', { id: input.allocation.walletAccountId })
        .getOne();
      if (!wallet) {
        throw new BadRequestException(`wallet_account not found id=${input.allocation.walletAccountId}`);
      }

      // 2. wallet 잔여 기준 credit/excess 재계산 (stale allocation race 대응).
      //    예치금/포인트 사용량은 그대로 유지하고 부족분/여신/신용초과 만 wallet-fresh 값으로 재분배.
      //    같은 정산코드 동시 주문에서 두 번째 요청도 throw 없이 자연스럽게 신용초과로 흡수.
      //    lines 배열도 깊은 사본 — caller input 변형 방지 + 명시적 재분배 결과 노출.
      const a = { ...input.allocation, lines: input.allocation.lines.map((l) => ({ ...l })) };
      const isPrePayment = wallet.settleCondition === 'PRE_PAYMENT';

      // 예치금: wallet 잔여 한도 적용 (stale 시 부족분은 credit/excess 로 이동)
      const depositCap = Math.min(a.depositUsedAmount, wallet.depositBalance);
      const depositShortfall = a.depositUsedAmount - depositCap;
      const carryover = depositShortfall + a.creditUsedAmount + a.creditExcessAmount;
      a.depositUsedAmount = depositCap;

      if (isPrePayment) {
        // 선정산: 일반 credit 사용 안 함. 부족분은 전부 신용초과 (4단계 워크플로 트리거).
        a.creditUsedAmount = 0;
        a.creditExcessAmount = carryover;
      } else {
        const creditLimitRemain = Math.max(0, wallet.creditLimit - wallet.creditUsedAmount);
        a.creditUsedAmount = Math.min(carryover, creditLimitRemain);
        a.creditExcessAmount = carryover - a.creditUsedAmount;
      }
      // payable_settlement_amount 는 보존 (deposit + credit + credit_excess 합 동일)
      // resourceBreakdown 도 재계산
      a.resourceBreakdown = {
        ...a.resourceBreakdown,
        DEPOSIT: a.depositUsedAmount,
        CREDIT: a.creditUsedAmount,
        CREDIT_EXCESS: a.creditExcessAmount,
      } as typeof a.resourceBreakdown;

      // 2-b. credit_excess 사용 시 사전 승인 approval 소비 (same-tx 보장). 미승인 시 throw → rollback.
      if (a.creditExcessAmount > 0) {
        if (!input.creditExcessApprovalId) {
          throw new CreditExcessApprovalRequiredError(a.creditExcessAmount, input.orderId);
        }
        await this.creditExcessApproval.consume(
          input.creditExcessApprovalId,
          input.orderId,
          a.creditExcessAmount,
          a.payableSettlementAmount,
          manager,
        );
      }

      // 라인 snapshot 도 carryover 적용된 totals 와 일관되게 재분배 (payable_base 비율).
      // 그렇지 않으면 SUM(lines.deposit/credit/excess) ≠ allocation totals 가 되어 invariant drift.
      const payableBaseSum = a.lines.reduce((s, l) => s + l.payableBase, 0);
      let depositRemain = a.depositUsedAmount;
      let creditRemain = a.creditUsedAmount;
      let excessRemain = a.creditExcessAmount;
      for (let i = 0; i < a.lines.length; i++) {
        const isLast = i === a.lines.length - 1;
        const ratio = payableBaseSum > 0 ? a.lines[i].payableBase / payableBaseSum : 0;
        const d = isLast ? depositRemain : Math.min(depositRemain, Math.floor(a.depositUsedAmount * ratio));
        const c = isLast ? creditRemain : Math.min(creditRemain, Math.floor(a.creditUsedAmount * ratio));
        const e = isLast ? excessRemain : Math.min(excessRemain, Math.floor(a.creditExcessAmount * ratio));
        a.lines[i] = { ...a.lines[i], depositUsedAmount: d, creditUsedAmount: c, creditExcessAmount: e };
        depositRemain -= d;
        creditRemain -= c;
        excessRemain -= e;
      }

      // 3. allocation row (재계산된 a 기준)
      const alloc = await manager.save(OrderPaymentAllocationEntity, {
        orderId: input.orderId,
        walletAccountId: a.walletAccountId,
        grossSettlementAmount: a.grossSettlementAmount,
        pointUsedAmount: a.pointUsedAmount,
        payableSettlementAmount: a.payableSettlementAmount,
        depositUsedAmount: a.depositUsedAmount,
        creditUsedAmount: a.creditUsedAmount,
        creditExcessAmount: a.creditExcessAmount,
        cardSurchargeAmount: a.cardSurchargeAmount,
        cardSurchargeApplied: input.cardSurchargeAppliedSnapshot ? 1 : 0,
        hasDiscount: input.hasDiscountSnapshot ? 1 : 0,
        settleMethodSnapshot: input.settleMethodSnapshot,
      });

      // 4. lines (재분배된 a.lines — top-level totals 와 SUM 일치 보장)
      const lineIds: string[] = [];
      for (const line of a.lines) {
        const saved = await manager.save(OrderPaymentAllocationLineEntity, {
          allocationId: alloc.id,
          orderId: input.orderId,
          orderProductMappingId: line.orderProductMappingId,
          orderDeliveryId: line.orderDeliveryId,
          productId: line.productId,
          brandId: line.brandId,
          category: line.category,
          partnerCompanyId: line.partnerCompanyId,
          orderType: line.orderType,
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

      // 5. point_usage
      for (const usage of a.pointUsages) {
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

      // 6. attempt row (INITIAL) per delivery
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

      // 7. wallet_transaction row split (same manager = same tx 보장, nested 회피)
      const walletTxIds: string[] = [];
      const records: Array<{ resource: WalletResourceType; amount: number; suffix: string; grantId?: string }> = [];
      if (a.depositUsedAmount > 0) {
        records.push({
          resource: WalletResourceType.DEPOSIT,
          amount: -a.depositUsedAmount,
          suffix: 'deposit',
        });
      }
      if (a.creditUsedAmount > 0) {
        records.push({
          resource: WalletResourceType.CREDIT,
          amount: a.creditUsedAmount,
          suffix: 'credit',
        });
      }
      if (a.creditExcessAmount > 0) {
        records.push({
          resource: WalletResourceType.CREDIT_EXCESS,
          amount: a.creditExcessAmount,
          suffix: 'credit_excess',
        });
      }
      // POINT는 grant 별 aggregate. 같은 grant 가 여러 라인에 걸쳐 사용된 경우
      // suffix(`point:${grantId}`) 중복 → idempotency_key 충돌로 두 번째 차감이 흡수돼버림. grant 합산 후 1 row 만 기록.
      const pointAgg: Record<string, number> = {};
      for (const usage of a.pointUsages) {
        if (usage.usedAmount > 0) {
          pointAgg[usage.pointGrantId] = (pointAgg[usage.pointGrantId] ?? 0) + usage.usedAmount;
        }
      }
      for (const [grantId, amount] of Object.entries(pointAgg)) {
        records.push({
          resource: WalletResourceType.POINT,
          amount: -amount,
          suffix: `point:${grantId}`,
          grantId,
        });
      }

      for (const rec of records) {
        const r = await this.ledger.recordTransaction(
          {
            walletAccountId: input.allocation.walletAccountId,
            orderId: input.orderId,
            type: 'CONFIRM',
            resourceType: rec.resource,
            amount: rec.amount,
            pointGrantId: rec.grantId ?? null,
            idempotencyKey: `confirm:${input.orderId}::${rec.suffix}`,
          },
          manager, // same-tx 보장
        );
        if (r.transactionId) walletTxIds.push(r.transactionId);
      }

      return { allocationId: alloc.id, lineIds, attemptIds, walletTransactionIds: walletTxIds, finalAllocation: a };
  }
}
