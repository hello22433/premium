import { resolveGalaxiaUsage } from './galaxia.usage.util';

describe('resolveGalaxiaUsage', () => {
  const build = (overrides: Partial<{ isUsed: boolean; faceValue: string; balance: string }> = {}) => ({
    isUsed: false,
    faceValue: '50000',
    balance: '50000',
    ...overrides,
  });

  test('isUsed=false 여도 잔액이 줄었으면(부분 사용) 교환(isActuallyUsed=true)으로 본다', () => {
    const verdict = resolveGalaxiaUsage(build({ isUsed: false, balance: '30000' }));

    expect(verdict.isActuallyUsed).toBe(true);
    expect(verdict.fullBalanceRemains).toBe(false);
    expect(verdict.balance).toBe(30000);
  });

  test('잔액이 전액 남으면(사용취소/미사용) 미사용 + fullBalanceRemains=true', () => {
    const verdict = resolveGalaxiaUsage(build({ isUsed: false, balance: '50000' }));

    expect(verdict.isActuallyUsed).toBe(false);
    expect(verdict.fullBalanceRemains).toBe(true);
    expect(verdict.balance).toBe(50000);
  });

  test('isUsed=true 면 잔액이 전액 남아도 교환으로 본다 (단, 전액 잔존 신호는 유지)', () => {
    const verdict = resolveGalaxiaUsage(build({ isUsed: true, balance: '50000' }));

    expect(verdict.isActuallyUsed).toBe(true);
    expect(verdict.fullBalanceRemains).toBe(true);
  });

  test('faceValue 가 0/누락이면 사용액 비교를 신뢰하지 않고 isUsed 단독 판정으로 폴백한다', () => {
    const zero = resolveGalaxiaUsage(build({ isUsed: false, faceValue: '0', balance: '0' }));
    expect(zero.isActuallyUsed).toBe(false);
    expect(zero.fullBalanceRemains).toBe(false);

    const missing = resolveGalaxiaUsage({ isUsed: true, faceValue: '', balance: '0' });
    expect(missing.isActuallyUsed).toBe(true);
    expect(missing.fullBalanceRemains).toBe(false);
  });
});
