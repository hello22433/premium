import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { IPartnerSettleVatCalculationMode } from '../interface/partner.settle.source.type';

/**
 * 정산 참고자료 금액 계산 (정본 §6.6 · 2026-07-29 17차 확정).
 *
 * 전 구간 `bigint` 정수산술이다. `number` 는 2^53 이후 정수 정확도를 잃고 `abs × percent / 100` 이
 * 부동소수점이라 중간곱에서 오차가 나므로 이 파일에서는 쓰지 않는다.
 *
 * 계산은 **절대값 기준으로 한 번** 하고 마지막에 원본 부호를 모든 구성금액에 동일하게 적용한다.
 * 부호 있는 값에 직접 절사/반올림하면 `+3002 / −3001`(net +1)처럼 취소가 원본을 상쇄하지 못한다.
 */

/** 단건 금액 상한 (정본 §5.1 57차-H3 ①). 1000조 — gift 정산 현실 범위 초과. */
export const LEDGER_AMOUNT_MAX = 1_000_000_000_000_000n;

/** 집계·carry 상한 (57차-H3 ③). BIGINT 상한(9.22×10^18) − 여유. */
export const AGGREGATE_AMOUNT_MAX = 9_000_000_000_000_000_000n;

/** `appliedPricePercent` 는 DECIMAL(7,4) 라 소수 4자리까지 exact 하다. */
const RATE_SCALE = 10_000n;
const COMMISSION_DIVISOR = 100n * RATE_SCALE;

export class LedgerAmountRangeError extends Error {}

export type SettleAmountInput = {
  /** 정가/사용액. 취소는 음수 */
  baseAmount: bigint;
  /** 할인금액(정산 참고자료). 부호는 baseAmount 를 따르므로 절대값으로 준다 */
  discountAmount?: bigint;
  /** DECIMAL(7,4) 문자열 또는 정수 percent */
  pricePercent: string | number;
  priceAdjustment: IPriceAdjustment;
  vatCalculationMode: IPartnerSettleVatCalculationMode;
};

export type SettleAmountBreakdown = {
  baseAmount: bigint;
  discountAmount: bigint;
  receivingCommissionAmount: bigint;
  givingCommissionAmount: bigint;
  vatAmount: bigint;
  feeTotalAmount: bigint;
  settleAmount: bigint;
};

/**
 * `"1.5"` → `15000`. DECIMAL(7,4) 를 넘는 정밀도는 원장 컬럼이 보존하지 못하므로 거부한다.
 */
export function parseRateScaled(pricePercent: string | number): bigint {
  const raw = String(pricePercent).trim();
  const matched = /^(\d{1,3})(?:\.(\d{1,4}))?$/.exec(raw);
  if (!matched) {
    throw new LedgerAmountRangeError(`정산 수수료율 형식 오류: ${raw}`);
  }
  const integer = BigInt(matched[1]);
  const fraction = BigInt((matched[2] ?? '').padEnd(4, '0'));
  return integer * RATE_SCALE + fraction;
}

/** 원 미만 절사. `ceilDiv`·부동소수점 금지 (§6.6). */
function truncatedCommission(absAmount: bigint, rateScaled: bigint): bigint {
  return (absAmount * rateScaled) / COMMISSION_DIVISOR;
}

/** 음수 없는 반올림(half-up). VAT 별도 방식에만 쓴다. */
function roundHalfUpTenth(absValue: bigint): bigint {
  return (absValue + 5n) / 10n;
}

function assertLedgerBound(label: string, value: bigint): void {
  const abs = value < 0n ? -value : value;
  if (abs > LEDGER_AMOUNT_MAX) {
    throw new LedgerAmountRangeError(`${label} 이 단건 상한(${LEDGER_AMOUNT_MAX})을 초과했다: ${value}`);
  }
}

/**
 * 조건 스냅샷을 적용해 구성금액 전부를 계산한다.
 *
 * `settleAmount = baseAmount − discountAmount − feeTotal`,
 * `feeTotal = (giving − receiving) + signedVat` (§6.6 최종식).
 */
export function calculateSettleAmounts(input: SettleAmountInput): SettleAmountBreakdown {
  assertLedgerBound('baseAmount', input.baseAmount);

  const sign = input.baseAmount < 0n ? -1n : 1n;
  const absBase = input.baseAmount * sign;
  const absDiscount = input.discountAmount === undefined ? 0n : abs(input.discountAmount);

  const rateScaled = parseRateScaled(input.pricePercent);
  const commission = truncatedCommission(absBase, rateScaled);

  const giving = input.priceAdjustment === 'DISCOUNT' ? commission : 0n;
  const receiving = input.priceAdjustment === 'ADDITIONAL' ? commission : 0n;
  const netCommission = giving - receiving;
  const vat = calculateVat(netCommission, input.vatCalculationMode);
  const feeTotal = netCommission + vat;
  const settle = absBase - absDiscount - feeTotal;

  assertLedgerBound('settleAmount', settle);

  return {
    baseAmount: input.baseAmount,
    discountAmount: absDiscount * sign,
    receivingCommissionAmount: receiving * sign,
    givingCommissionAmount: giving * sign,
    vatAmount: vat * sign,
    feeTotalAmount: feeTotal * sign,
    settleAmount: settle * sign,
  };
}

/**
 * VAT 는 거래 당시 정책을 그대로 적용한다.
 * - `SEPARATE_ROUND`: 수수료 × 10% 반올림, 수수료 방향 부호
 * - `INCLUDED_REMAINDER`: 총 수수료 F 에서 공급가액 절사 후 잔액 — 합계 F 를 항상 보존
 * - `NONE`: 0
 */
function calculateVat(netCommission: bigint, mode: IPartnerSettleVatCalculationMode): bigint {
  if (netCommission === 0n) return 0n;
  const sign = netCommission < 0n ? -1n : 1n;
  const absNet = netCommission * sign;

  switch (mode) {
    case 'SEPARATE_ROUND':
      return roundHalfUpTenth(absNet) * sign;
    case 'INCLUDED_REMAINDER': {
      const supply = (absNet * 10n) / 11n;
      return (absNet - supply) * sign;
    }
    case 'NONE':
    default:
      return 0n;
  }
}

/** 전액취소: 원본 구성금액을 그대로 반대 부호로 복제한다(재계산 금지 · §6.4). */
export function reverseAmounts(original: SettleAmountBreakdown): SettleAmountBreakdown {
  return {
    baseAmount: -original.baseAmount,
    discountAmount: -original.discountAmount,
    receivingCommissionAmount: -original.receivingCommissionAmount,
    givingCommissionAmount: -original.givingCommissionAmount,
    vatAmount: -original.vatAmount,
    feeTotalAmount: -original.feeTotalAmount,
    settleAmount: -original.settleAmount,
  };
}

export type PartialReversalInput = {
  /** 원본 row 의 구성금액 (양수) */
  original: SettleAmountBreakdown;
  /** 이번 취소분 baseAmount 절대값 */
  cancelBaseAmount: bigint;
  /** 같은 원본에 대한 기존 역분개 누적 절대값 */
  reversedBaseAmountSum: bigint;
  reversedSettleAmountSum: bigint;
  pricePercent: string | number;
  priceAdjustment: IPriceAdjustment;
  vatCalculationMode: IPartnerSettleVatCalculationMode;
};

/**
 * 부분취소 배분 (§6.4 · 33차-H3 이중 불변식).
 *
 * `Σ|역분개 baseAmount| ≤ 원본 baseAmount` **와** `Σ|역분개 settleAmount| ≤ 원본 settleAmount` 를 둘 다
 * 강제한다. settle 상한만 보면 100% 할인 원본(base=100·settle=0)에서 base 과다취소가 통과한다.
 *
 * 원본을 소진하는 마지막 취소는 base·settle 잔여액을 **정확히** 소진한다 — 개별 절사 합이 원본과
 * 1원 어긋나 net 0 이 깨지는 것을 막는다.
 */
export function calculatePartialReversal(input: PartialReversalInput): SettleAmountBreakdown {
  const originalBase = abs(input.original.baseAmount);
  const originalSettle = abs(input.original.settleAmount);
  const cancelBase = abs(input.cancelBaseAmount);

  const remainingBase = originalBase - abs(input.reversedBaseAmountSum);
  const remainingSettle = originalSettle - abs(input.reversedSettleAmountSum);

  if (cancelBase <= 0n) {
    throw new LedgerAmountRangeError('취소 baseAmount 는 0보다 커야 한다');
  }
  if (cancelBase > remainingBase) {
    throw new LedgerAmountRangeError(
      `역분개 누적이 원본 baseAmount 를 초과한다 (잔여 ${remainingBase}, 요청 ${cancelBase})`,
    );
  }

  const computed = calculateSettleAmounts({
    baseAmount: cancelBase,
    pricePercent: input.pricePercent,
    priceAdjustment: input.priceAdjustment,
    vatCalculationMode: input.vatCalculationMode,
  });

  // 마지막 취소는 잔여를 정확히 소진한다.
  if (cancelBase === remainingBase) {
    const drained: SettleAmountBreakdown = {
      ...computed,
      settleAmount: remainingSettle,
      feeTotalAmount: cancelBase - remainingSettle,
    };
    return reverseAmounts(drained);
  }

  if (computed.settleAmount > remainingSettle) {
    throw new LedgerAmountRangeError(
      `역분개 누적이 원본 settleAmount 를 초과한다 (잔여 ${remainingSettle}, 계산 ${computed.settleAmount})`,
    );
  }
  return reverseAmounts(computed);
}

/** 집계 상한 검사 (57차-H3 ③). 초과 시 부분 write 없이 중단시키기 위해 호출부가 먼저 쓴다. */
export function assertAggregateBound(label: string, value: bigint): void {
  if (abs(value) > AGGREGATE_AMOUNT_MAX) {
    throw new LedgerAmountRangeError(`${label} 이 집계 상한(${AGGREGATE_AMOUNT_MAX})을 초과했다: ${value}`);
  }
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}
