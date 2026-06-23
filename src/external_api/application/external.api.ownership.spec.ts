import { ExternalApiService } from './external.api.service';
import { ExternalApiException } from '../api/external.api.exception.filter';

/**
 * PR2 Phase 4 — 주문 소유권 검사(apiAppId 기준) 단위 검증.
 * 모든 trId 기반 조회/상태/취소/재발송이 findOrderDeliveryByTrId → assertOrderOwnership 를 단일 경유한다.
 * 3분기: (1) apiAppId 적재 → 호출 apiApp 일치, (2) 레거시 NULL 폴백(default billing user),
 *        (3) 매핑모드인데 apiAppId 미적재 → 불변식 위반 거절.
 */
describe('assertOrderOwnership (PR2 Phase 4)', () => {
  // assertOrderOwnership 은 순수 로직(repo 미사용)이라 prototype 인스턴스로 직접 호출.
  const svc = Object.create(ExternalApiService.prototype) as {
    assertOrderOwnership: (order: unknown, account: unknown, ctx: unknown) => void;
  };
  const ctx = (appId: unknown) => ({ apiApp: { id: appId } });
  const account = (userId: number) => ({ user: { id: userId } });
  const call = (order: unknown, acc: unknown, c: unknown) => () => svc.assertOrderOwnership(order, acc, c);

  const expectCode = (fn: () => void, code: string) => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(ExternalApiException);
      expect((e as ExternalApiException).code).toBe(code);
      return;
    }
    throw new Error(`expected throw with code ${code} but none thrown`);
  };

  it('apiAppId 적재 + 호출 apiApp 일치 → 통과 (매핑모드 주문)', () => {
    expect(call({ apiAppId: '10', clientUserId: 77, userId: 1 }, account(1), ctx('10'))).not.toThrow();
  });

  it('apiAppId 적재 + 호출 apiApp 일치 → 통과 (단순모드 주문)', () => {
    expect(call({ apiAppId: '10', clientUserId: null, userId: 1 }, account(1), ctx('10'))).not.toThrow();
  });

  it('apiAppId 적재 + 타 apiApp 호출 → 4002', () => {
    expectCode(call({ apiAppId: '10', clientUserId: 77, userId: 1 }, account(1), ctx('99')), '4002');
  });

  it('apiAppId bigint(string) vs number 혼용도 String() 통일로 일치 판정', () => {
    expect(call({ apiAppId: 10, clientUserId: null, userId: 1 }, account(1), ctx(10))).not.toThrow();
  });

  it('레거시 NULL 폴백: apiAppId null + clientUserId null + userId 일치 → 통과', () => {
    expect(call({ apiAppId: null, clientUserId: null, userId: 42 }, account(42), ctx('10'))).not.toThrow();
  });

  it('레거시 NULL 폴백: userId 불일치 → 4002', () => {
    expectCode(call({ apiAppId: null, clientUserId: null, userId: 42 }, account(7), ctx('10')), '4002');
  });

  it('매핑모드(clientUserId≠null)인데 apiAppId 미적재 → 불변식 위반 4002', () => {
    expectCode(call({ apiAppId: null, clientUserId: 77, userId: 1 }, account(1), ctx('10')), '4002');
  });
});
