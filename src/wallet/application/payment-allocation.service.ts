import { BadRequestException, Injectable } from '@nestjs/common';
import { WalletResourceType } from '../interface/wallet-resource-type';

export interface AllocationLineInput {
  orderProductMappingId: number;
  orderDeliveryId?: number | null;
  productId?: number | null;
  brandId?: number | null;
  category?: string | null;
  partnerCompanyId?: number | null;
  orderType: string;
  grossSettlementAmount: number; // calculateSettlementPrice(mapping, false, delivery)
  appliedFeePercent?: number | null;
  appliedPriceAdjustment?: 'DISCOUNT' | 'ADDITIONAL' | null;
  pointPolicyEffect: 'ALLOW' | 'DENY';
}

export interface AllocationInput {
  orderId: number;
  walletAccountId: string;
  lines: AllocationLineInput[];
  cardSurchargeApplied: boolean;
  requestedPointAmount: number; // 사용자 요청 포인트 사용액
  requestedDepositAmount?: number | null; // 후정산 + 예치금 부분 사용 (null = 자동)
  availableDeposit: number; // wallet_account.deposit_balance 잔액
  creditLimit: number;
  creditUsedAmountBefore: number;
  isPrePayment: boolean; // 선정산 여부
}

export interface AllocationLineResult {
  orderProductMappingId: number;
  orderDeliveryId: number | null;
  grossSettlementAmount: number;
  pointUsedAmount: number;
  payableBase: number;
  depositUsedAmount: number;
  creditUsedAmount: number;
  creditExcessAmount: number;
  appliedFeePercent: number | null;
  appliedPriceAdjustment: 'DISCOUNT' | 'ADDITIONAL' | null;
}

export interface AllocationResult {
  orderId: number;
  walletAccountId: string;
  grossSettlementAmount: number;
  pointUsedAmount: number;
  cardSurchargeBase: number;
  cardSurchargeAmount: number;
  payableSettlementAmount: number;
  depositUsedAmount: number;
  creditUsedAmount: number;
  creditExcessAmount: number;
  cardSurchargeApplied: boolean;
  hasDiscount: boolean;
  lines: AllocationLineResult[];
  resourceBreakdown: Record<WalletResourceType, number>;
}

/**
 * 발송확정 시점 정산금액 배분 계산 (DB 쓰기 없음, pure 함수).
 * 우선순위 (고객사 입장, 싼 재원 먼저):
 *   포인트 → 예치금 → 여신 → 신용초과
 *
 * 카드할증 = 주문 단위 풀 (§5). 라인별 share 저장 안 함.
 * mutex: 카드할증 + 할인/할증 동시 적용 불가.
 */
@Injectable()
export class PaymentAllocationService {
  allocate(input: AllocationInput): AllocationResult {
    this.validateMutex(input);

    const lines = input.lines.map((l) => this.computeLine(l));
    const grossSettlementAmount = lines.reduce((s, l) => s + l.grossSettlementAmount, 0);

    // 1. 포인트 분배 (ALLOW 라인에만, 라인 base 비율)
    const allowableGross = lines
      .filter((l, idx) => input.lines[idx].pointPolicyEffect === 'ALLOW')
      .reduce((s, l) => s + l.grossSettlementAmount, 0);
    const pointToUse = Math.min(input.requestedPointAmount, allowableGross);
    let pointRemaining = pointToUse;
    for (let i = 0; i < lines.length; i++) {
      if (input.lines[i].pointPolicyEffect !== 'ALLOW') continue;
      if (pointRemaining <= 0) break;
      const portion =
        i === lines.length - 1
          ? pointRemaining
          : Math.min(pointRemaining, Math.floor((pointToUse * lines[i].grossSettlementAmount) / allowableGross));
      lines[i].pointUsedAmount = portion;
      lines[i].payableBase = lines[i].grossSettlementAmount - portion;
      pointRemaining -= portion;
    }
    // 잔여 (rounding) → 마지막 ALLOW 라인 흡수
    if (pointRemaining > 0) {
      for (let i = lines.length - 1; i >= 0; i--) {
        if (input.lines[i].pointPolicyEffect === 'ALLOW') {
          lines[i].pointUsedAmount += pointRemaining;
          lines[i].payableBase = lines[i].grossSettlementAmount - lines[i].pointUsedAmount;
          break;
        }
      }
    }

    const pointUsedAmount = lines.reduce((s, l) => s + l.pointUsedAmount, 0);

    // 2. 주문 단위 카드할증 (1회 계산)
    const cardSurchargeBase = grossSettlementAmount - pointUsedAmount;
    const cardSurchargeTotal = this.applyCardSurcharge(cardSurchargeBase, input.cardSurchargeApplied);
    const cardSurchargeAmount = cardSurchargeTotal - cardSurchargeBase;
    const payableSettlementAmount = cardSurchargeTotal;

    // 3. 예치금/여신/신용초과 분배 (주문 단위 결정 → 라인 비율 분배)
    const depositCap =
      input.requestedDepositAmount != null
        ? Math.min(input.requestedDepositAmount, input.availableDeposit)
        : input.isPrePayment
          ? input.availableDeposit
          : 0; // 후정산 default = 예치금 사용 안 함 (사용자 지정 시 깐 만큼)

    const depositUsed = Math.min(payableSettlementAmount, depositCap);
    const need = payableSettlementAmount - depositUsed;
    const availableCredit = Math.max(0, input.creditLimit - input.creditUsedAmountBefore);
    const creditUsed = Math.min(need, availableCredit);
    const creditExcess = need - creditUsed;

    if (input.isPrePayment && creditUsed + creditExcess > 0) {
      // 선정산 + 예치금 부족 → 신용초과 흐름 (Step A~D). 발송확정 호출자가 ApprovalId 확인 후 진입.
    }

    // 라인별 비율 분배 (정보용)
    const payableBaseSum = lines.reduce((s, l) => s + l.payableBase, 0);
    let depositRemain = depositUsed;
    let creditRemain = creditUsed;
    let excessRemain = creditExcess;
    for (let i = 0; i < lines.length; i++) {
      const isLast = i === lines.length - 1;
      const ratio = payableBaseSum > 0 ? lines[i].payableBase / payableBaseSum : 0;
      lines[i].depositUsedAmount = isLast ? depositRemain : Math.min(depositRemain, Math.floor(depositUsed * ratio));
      lines[i].creditUsedAmount = isLast ? creditRemain : Math.min(creditRemain, Math.floor(creditUsed * ratio));
      lines[i].creditExcessAmount = isLast ? excessRemain : Math.min(excessRemain, Math.floor(creditExcess * ratio));
      depositRemain -= lines[i].depositUsedAmount;
      creditRemain -= lines[i].creditUsedAmount;
      excessRemain -= lines[i].creditExcessAmount;
    }

    return {
      orderId: input.orderId,
      walletAccountId: input.walletAccountId,
      grossSettlementAmount,
      pointUsedAmount,
      cardSurchargeBase,
      cardSurchargeAmount,
      payableSettlementAmount,
      depositUsedAmount: depositUsed,
      creditUsedAmount: creditUsed,
      creditExcessAmount: creditExcess,
      cardSurchargeApplied: input.cardSurchargeApplied,
      hasDiscount: input.lines.some((l) => l.appliedPriceAdjustment != null),
      lines,
      resourceBreakdown: {
        [WalletResourceType.POINT]: pointUsedAmount,
        [WalletResourceType.DEPOSIT]: depositUsed,
        [WalletResourceType.CREDIT]: creditUsed,
        [WalletResourceType.CREDIT_EXCESS]: creditExcess,
      },
    };
  }

  private validateMutex(input: AllocationInput): void {
    const hasDiscount = input.lines.some((l) => l.appliedPriceAdjustment != null);
    if (input.cardSurchargeApplied && hasDiscount) {
      throw new BadRequestException('카드할증과 할인/할증 동시 적용 불가 (Cross-Cutting Invariants §5 mutex)');
    }
  }

  private computeLine(input: AllocationLineInput): AllocationLineResult {
    return {
      orderProductMappingId: input.orderProductMappingId,
      orderDeliveryId: input.orderDeliveryId ?? null,
      grossSettlementAmount: input.grossSettlementAmount,
      pointUsedAmount: 0,
      payableBase: input.grossSettlementAmount,
      depositUsedAmount: 0,
      creditUsedAmount: 0,
      creditExcessAmount: 0,
      appliedFeePercent: input.appliedFeePercent ?? null,
      appliedPriceAdjustment: input.appliedPriceAdjustment ?? null,
    };
  }

  /** order.fee.calculator.applyCardSurcharge 와 동일 식 */
  applyCardSurcharge(amount: number, applied: boolean): number {
    if (!applied) return amount;
    return Math.floor((amount + Math.round(amount * 0.03)) / 10) * 10;
  }
}
