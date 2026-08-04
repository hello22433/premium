import {
  calculatePartialReversal,
  EMPTY_BREAKDOWN,
  SettleAmountBreakdown,
  sumBreakdowns,
  calculateSettleAmounts,
  LedgerAmountRangeError,
  LEDGER_AMOUNT_MAX,
  parseRateScaled,
  reverseAmounts,
  assertAggregateBound,
} from './settle.amount';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';

describe('parseRateScaled', () => {
  it('DECIMAL(7,4) 소수율을 정수 scaled 로 보존한다', () => {
    expect(parseRateScaled('1.5')).toBe(15_000n);
    expect(parseRateScaled('0.0001')).toBe(1n);
    expect(parseRateScaled(10)).toBe(100_000n);
  });

  it('컬럼이 보존하지 못하는 정밀도·형식은 거부한다', () => {
    expect(() => parseRateScaled('1.00001')).toThrow(LedgerAmountRangeError);
    expect(() => parseRateScaled('-5')).toThrow(LedgerAmountRangeError);
    expect(() => parseRateScaled('')).toThrow(LedgerAmountRangeError);
  });
});

describe('calculateSettleAmounts — 정본 §6.6 검증 상수', () => {
  it('CU 1.5% 는 원 미만 절사한다 (152,411.1 → 152,411)', () => {
    const result = calculateSettleAmounts({
      baseAmount: 10_160_740n,
      pricePercent: '1.5',
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      vatCalculationMode: 'NONE',
    });
    expect(result.givingCommissionAmount).toBe(152_411n);
    expect(result.settleAmount).toBe(10_160_740n - 152_411n);
  });

  it('GS넷비전 1.5% (158,494.2 → 158,494)', () => {
    const result = calculateSettleAmounts({
      baseAmount: 10_566_280n,
      pricePercent: '1.5',
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      vatCalculationMode: 'NONE',
    });
    expect(result.givingCommissionAmount).toBe(158_494n);
  });

  it('SK주유권 할증 3% + VAT 별도 = 합계 −37,125 · 정산 1,162,125', () => {
    const result = calculateSettleAmounts({
      baseAmount: 1_125_000n,
      pricePercent: '3',
      priceAdjustment: IPriceAdjustment.ADDITIONAL,
      vatCalculationMode: 'SEPARATE_ROUND',
    });
    expect(result.receivingCommissionAmount).toBe(33_750n);
    expect(result.vatAmount).toBe(-3_375n);
    expect(result.feeTotalAmount).toBe(-37_125n);
    expect(result.settleAmount).toBe(1_162_125n);
  });

  it('VAT 포함 방식은 총 수수료를 보존한다 (supply 절사 + 잔액 VAT)', () => {
    const result = calculateSettleAmounts({
      baseAmount: 1_000_000n,
      pricePercent: '1.5',
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      vatCalculationMode: 'INCLUDED_REMAINDER',
    });
    // F = 15,000 → supply = 13,636, vat = 1,364. 합계는 언제나 F.
    expect(result.givingCommissionAmount).toBe(15_000n);
    expect(result.vatAmount).toBe(1_364n);
    expect(result.feeTotalAmount).toBe(15_000n + 1_364n);
  });
});

describe('부호 반전 net 0 (정본 §13 3,335원·10% 케이스)', () => {
  const original = calculateSettleAmounts({
    baseAmount: 3_335n,
    pricePercent: '10',
    priceAdjustment: IPriceAdjustment.DISCOUNT,
    vatCalculationMode: 'NONE',
  });

  it('절사 기준 원본 정산액은 +3,002 다', () => {
    expect(original.settleAmount).toBe(3_002n);
  });

  it('전액취소는 구성금액 전부를 반대 부호로 복제해 net 0 이다', () => {
    const reversal = reverseAmounts(original);
    expect(reversal.settleAmount).toBe(-3_002n);
    expect(original.settleAmount + reversal.settleAmount).toBe(0n);
    expect(original.baseAmount + reversal.baseAmount).toBe(0n);
    expect(original.feeTotalAmount + reversal.feeTotalAmount).toBe(0n);
  });

  it('음수 baseAmount 를 직접 계산해도 부호만 반대인 동일 금액이다', () => {
    const negative = calculateSettleAmounts({
      baseAmount: -3_335n,
      pricePercent: '10',
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      vatCalculationMode: 'NONE',
    });
    expect(negative.settleAmount).toBe(-3_002n);
  });
});

describe('부분취소 배분 (§6.4 · 33차-H3)', () => {
  const original = calculateSettleAmounts({
    baseAmount: 3_335n,
    pricePercent: '10',
    priceAdjustment: IPriceAdjustment.DISCOUNT,
    vatCalculationMode: 'NONE',
  });

  const partial = (cancelBase: bigint, previous: SettleAmountBreakdown[] = []) =>
    calculatePartialReversal({
      original,
      cancelBaseAmount: cancelBase,
      reversedTotals: sumBreakdowns(previous),
      pricePercent: '10',
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      vatCalculationMode: 'NONE',
    });

  it('분할 취소 누적이 원본과 정확히 상쇄된다 (개별 절사 합 오차 없음)', () => {
    const first = partial(1_000n);
    const second = partial(2_335n, [first]);

    expect(first.baseAmount + second.baseAmount).toBe(-3_335n);
    expect(first.settleAmount + second.settleAmount).toBe(-3_002n);
    expect(original.settleAmount + first.settleAmount + second.settleAmount).toBe(0n);
  });

  it('마지막 취소는 base·settle 잔여를 정확히 소진한다', () => {
    const first = partial(3_334n);
    const last = partial(1n, [first]);
    expect(first.baseAmount + last.baseAmount).toBe(-3_335n);
    expect(first.settleAmount + last.settleAmount).toBe(-3_002n);
  });

  it('누적 절대값이 원본 baseAmount 를 넘으면 거부한다', () => {
    const all = partial(3_335n);
    expect(() => partial(1n, [all])).toThrow(LedgerAmountRangeError);
  });

  it('100% 할인 원본(settle 0)에서도 baseAmount 과다취소를 막는다', () => {
    const fullDiscount = calculateSettleAmounts({
      baseAmount: 100n,
      pricePercent: '100',
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      vatCalculationMode: 'NONE',
    });
    expect(fullDiscount.settleAmount).toBe(0n);

    expect(() =>
      calculatePartialReversal({
        original: fullDiscount,
        cancelBaseAmount: 1_000n,
        reversedTotals: EMPTY_BREAKDOWN,
        pricePercent: '100',
        priceAdjustment: IPriceAdjustment.DISCOUNT,
        vatCalculationMode: 'NONE',
      }),
    ).toThrow(LedgerAmountRangeError);

    const drained = calculatePartialReversal({
      original: fullDiscount,
      cancelBaseAmount: 100n,
      reversedTotals: EMPTY_BREAKDOWN,
      pricePercent: '100',
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      vatCalculationMode: 'NONE',
    });
    expect(drained.baseAmount).toBe(-100n);
    expect(drained.settleAmount).toBe(0n);
  });

  it('할인금액 스냅샷도 배분되어 전량 취소 시 0 으로 상쇄된다', () => {
    // 원본 base=100 · discount=10 · fee=0 → settle=90. 50 + 50 으로 나눠 취소한다.
    const withDiscount = calculateSettleAmounts({
      baseAmount: 100n,
      discountAmount: 10n,
      pricePercent: '0',
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      vatCalculationMode: 'NONE',
    });
    expect(withDiscount.settleAmount).toBe(90n);

    const input = (cancelBase: bigint, previous: SettleAmountBreakdown[]) => ({
      original: withDiscount,
      cancelBaseAmount: cancelBase,
      reversedTotals: sumBreakdowns(previous),
      pricePercent: '0',
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      vatCalculationMode: 'NONE' as const,
    });

    const first = calculatePartialReversal(input(50n, []));
    const second = calculatePartialReversal(input(50n, [first]));

    expect(first.discountAmount).toBe(-5n);
    expect(withDiscount.discountAmount + first.discountAmount + second.discountAmount).toBe(0n);
    expect(withDiscount.baseAmount + first.baseAmount + second.baseAmount).toBe(0n);
    expect(withDiscount.settleAmount + first.settleAmount + second.settleAmount).toBe(0n);
  });

  it('마지막 취소 행도 giving − receiving + vat = feeTotal 항등식을 유지한다', () => {
    // 절사·반올림 잔여가 마지막 행에 몰리는 케이스(할증 + VAT 별도).
    const surcharge = calculateSettleAmounts({
      baseAmount: 3_333n,
      discountAmount: 7n,
      pricePercent: '3.3',
      priceAdjustment: IPriceAdjustment.ADDITIONAL,
      vatCalculationMode: 'SEPARATE_ROUND',
    });

    const input = (cancelBase: bigint, previous: SettleAmountBreakdown[]) => ({
      original: surcharge,
      cancelBaseAmount: cancelBase,
      reversedTotals: sumBreakdowns(previous),
      pricePercent: '3.3',
      priceAdjustment: IPriceAdjustment.ADDITIONAL,
      vatCalculationMode: 'SEPARATE_ROUND' as const,
    });

    const first = calculatePartialReversal(input(1_111n, []));
    const last = calculatePartialReversal(input(2_222n, [first]));

    for (const row of [surcharge, first, last]) {
      expect(row.givingCommissionAmount - row.receivingCommissionAmount + row.vatAmount).toBe(
        row.feeTotalAmount,
      );
      expect(row.baseAmount - row.discountAmount - row.feeTotalAmount).toBe(row.settleAmount);
    }

    for (const key of [
      'baseAmount',
      'discountAmount',
      'receivingCommissionAmount',
      'givingCommissionAmount',
      'vatAmount',
      'feeTotalAmount',
      'settleAmount',
    ] as const) {
      expect(surcharge[key] + first[key] + last[key]).toBe(0n);
    }
  });
});

describe('금액 상한 (57차-H3)', () => {
  it('단건 baseAmount 상한 초과는 거부한다', () => {
    expect(() =>
      calculateSettleAmounts({
        baseAmount: LEDGER_AMOUNT_MAX + 1n,
        pricePercent: '0',
        priceAdjustment: IPriceAdjustment.DISCOUNT,
        vatCalculationMode: 'NONE',
      }),
    ).toThrow(LedgerAmountRangeError);
  });

  it('상한 직전 금액도 중간곱 손실 없이 정확히 계산한다 (부동소수점 대조)', () => {
    const base = LEDGER_AMOUNT_MAX - 1n; // 999,999,999,999,999
    const result = calculateSettleAmounts({
      baseAmount: base,
      pricePercent: '10',
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      vatCalculationMode: 'NONE',
    });
    // 정확값 99,999,999,999,999.9 → 절사 99,999,999,999,999
    expect(result.givingCommissionAmount).toBe(99_999_999_999_999n);
    expect(result.settleAmount).toBe(base - 99_999_999_999_999n);
  });

  it('집계 상한 초과는 별도로 막는다', () => {
    expect(() => assertAggregateBound('confirmedTotalAmount', 9_000_000_000_000_000_001n)).toThrow(
      LedgerAmountRangeError,
    );
  });
});
