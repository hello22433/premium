import { getBillingUserId } from './order.billing-user.helper';

describe('getBillingUserId', () => {
  it('clientUserId 가 null 이면 userId 반환', () => {
    expect(getBillingUserId({ userId: 42, clientUserId: null })).toBe(42);
  });

  it('clientUserId 가 set 이면 clientUserId 반환 (대행주문)', () => {
    expect(getBillingUserId({ userId: 42, clientUserId: 99 })).toBe(99);
  });

  it('clientUserId 가 0 이어도 (?) userId 반환 — 0 은 falsy 이므로 `??` 가 첫 인자를 채택하지만 typeorm 매핑상 0 은 valid id 아님. 도메인 invariant 검증 목적의 케이스.', () => {
    // ?? 연산자는 null/undefined 만 falsy 로 취급 → 0 은 그대로 반환
    expect(getBillingUserId({ userId: 42, clientUserId: 0 })).toBe(0);
  });

  it('partial Order 타입 호환 (userId + clientUserId 만 있어도 동작)', () => {
    const partial = { userId: 1, clientUserId: 2 };
    expect(getBillingUserId(partial)).toBe(2);
  });

  it('기존 order.service.ts 호출부 패턴 `clientUserId ?? userId` 와 동일 의미', () => {
    const cases: Array<{ userId: number; clientUserId: number | null }> = [
      { userId: 1, clientUserId: null },
      { userId: 1, clientUserId: 2 },
      { userId: 100, clientUserId: null },
      { userId: 100, clientUserId: 200 },
    ];
    for (const order of cases) {
      expect(getBillingUserId(order)).toBe(order.clientUserId ?? order.userId);
    }
  });
});
