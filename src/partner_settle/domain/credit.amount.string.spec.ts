import {
  CreditAmountFormatError,
  parseNonNegativeAmount,
  serializeAmount,
} from './credit.amount.string';

describe('parseNonNegativeAmount (정본 §5 금액 계약 · 28차)', () => {
  it('canonical 정수 문자열을 BigInt 로 파싱한다', () => {
    expect(parseNonNegativeAmount('0')).toBe(0n);
    expect(parseNonNegativeAmount('100')).toBe(100n);
    expect(parseNonNegativeAmount('9007199254740993')).toBe(9_007_199_254_740_993n);
  });

  it.each(['000100', '+100', '-0', '-100', ' 100 ', '', '1.0', '1e3', 'abc', '0x10'])(
    'canonical 위반 문자열(%j)은 거부한다',
    (raw) => {
      expect(() => parseNonNegativeAmount(raw)).toThrow(CreditAmountFormatError);
    },
  );

  it.each([100, null, undefined, {}, 100n])('문자열이 아닌 입력(%p)은 거부한다', (raw) => {
    expect(() => parseNonNegativeAmount(raw as unknown)).toThrow(CreditAmountFormatError);
  });
});

describe('serializeAmount', () => {
  it('BigInt 를 canonical decimal string 으로 직렬화한다', () => {
    expect(serializeAmount(0n)).toBe('0');
    expect(serializeAmount(9_007_199_254_740_993n)).toBe('9007199254740993');
    expect(serializeAmount(-42n)).toBe('-42');
  });

  it('round-trip: parse 후 serialize 가 원문과 같다(음수 불허 범위)', () => {
    for (const raw of ['0', '1', '100', '9007199254740993']) {
      expect(serializeAmount(parseNonNegativeAmount(raw))).toBe(raw);
    }
  });
});
