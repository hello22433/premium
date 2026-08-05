import {
  assertBalanceInvariant,
  BalanceInvariantError,
  PartnerBalanceResult,
} from './partner.balance.inquiry';

const base = (over: Partial<PartnerBalanceResult>): PartnerBalanceResult => ({
  subItemKey: 'NONE',
  status: 'AVAILABLE',
  balance: '0',
  ...over,
});

describe('assertBalanceInvariant (60차-M1)', () => {
  it('AVAILABLE + non-null 을 허용한다 (정상 0원은 AVAILABLE + "0")', () => {
    expect(() => assertBalanceInvariant(base({ status: 'AVAILABLE', balance: '0' }))).not.toThrow();
    expect(() => assertBalanceInvariant(base({ status: 'AVAILABLE', balance: '123' }))).not.toThrow();
  });

  it.each(['NOT_AVAILABLE', 'FAILED'] as const)('%s + null 을 허용한다', (status) => {
    expect(() => assertBalanceInvariant(base({ status, balance: null }))).not.toThrow();
  });

  it('AVAILABLE + null 을 거부한다', () => {
    expect(() => assertBalanceInvariant(base({ status: 'AVAILABLE', balance: null }))).toThrow(
      BalanceInvariantError,
    );
  });

  it.each(['NOT_AVAILABLE', 'FAILED'] as const)('%s + non-null 을 거부한다', (status) => {
    expect(() => assertBalanceInvariant(base({ status, balance: '10' }))).toThrow(BalanceInvariantError);
  });
});
