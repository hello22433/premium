import { ExternalApiService } from './external.api.service';

/**
 * PR2 리뷰 보강 #3 — GET /products 가 매핑모드(externalCustomerId)면 매핑 billing user 기준
 * 할당상품을 조회한다(주문 생성과 동일 resolver). 미지정이면 default billing(account.user).
 */
describe('ExternalApiService.getProducts billing 스코프 (PR2 리뷰 #3)', () => {
  const makeSvc = (resolved: unknown) => {
    const svc = Object.create(ExternalApiService.prototype) as any;
    // §9 컷오버 게이트 — 단위 테스트 기본값은 '미전환 건'(legacy 경로 그대로 통과).
    (svc as any).cutoverGuard = {
      assertLegacyAllowed: jest.fn().mockResolvedValue(undefined),
      assertRefundExecutionAllowed: jest.fn().mockResolvedValue(undefined),
      isCutover: jest.fn().mockResolvedValue(false),
      splitLegacyAllowed: jest.fn(async (ids: number[]) => ({ allowed: ids, blocked: [] })),
    };
    svc.mappingResolver = { resolveBillingTarget: jest.fn(async () => resolved) };
    svc.getProductsForBilling = jest.fn(async () => ({ result: { code: '0000', data: [] } }));
    return svc;
  };
  const account = { user: { id: 42 } };
  const ctx = { apiApp: { id: '1', requireExternalCustomerId: false } };

  it('매핑모드: externalCustomerId 지정 → 매핑 billing user 기준 상품 조회', async () => {
    const mappedBillingUser = { id: 99 };
    const svc = makeSvc({ billingUser: mappedBillingUser, clientUserId: 99, externalCustomerId: 'wisead-c1' });

    await svc.getProducts(account, ctx, 'P1', 'wisead-c1');

    expect(svc.mappingResolver.resolveBillingTarget).toHaveBeenCalledWith('1', 'wisead-c1', 42, false);
    expect(svc.getProductsForBilling).toHaveBeenCalledWith(mappedBillingUser, 'P1');
  });

  it('단순모드: externalCustomerId 미지정 → default billing(account.user) 기준 상품 조회', async () => {
    const svc = makeSvc({ billingUser: account.user, clientUserId: null, externalCustomerId: null });

    await svc.getProducts(account, ctx, undefined, undefined);

    expect(svc.mappingResolver.resolveBillingTarget).toHaveBeenCalledWith('1', undefined, 42, false);
    expect(svc.getProductsForBilling).toHaveBeenCalledWith(account.user, undefined);
  });

  it('매핑 필수 모드: getProducts 가 requireExternalCustomerId=true 를 resolver 로 전달', async () => {
    const svc = makeSvc({ billingUser: { id: 99 }, clientUserId: 99, externalCustomerId: 'wisead-c1' });
    const ctxRequire = { apiApp: { id: '1', requireExternalCustomerId: true } };

    await svc.getProducts(account, ctxRequire, 'P1', 'wisead-c1');

    expect(svc.mappingResolver.resolveBillingTarget).toHaveBeenCalledWith('1', 'wisead-c1', 42, true);
  });

  it('미등록 externalCustomerId → resolver 가 4003 throw(default 폴백 금지) 전파', async () => {
    const svc = Object.create(ExternalApiService.prototype) as any;
    // §9 컷오버 게이트 — 단위 테스트 기본값은 '미전환 건'(legacy 경로 그대로 통과).
    (svc as any).cutoverGuard = {
      assertLegacyAllowed: jest.fn().mockResolvedValue(undefined),
      assertRefundExecutionAllowed: jest.fn().mockResolvedValue(undefined),
      isCutover: jest.fn().mockResolvedValue(false),
      splitLegacyAllowed: jest.fn(async (ids: number[]) => ({ allowed: ids, blocked: [] })),
    };
    svc.mappingResolver = {
      resolveBillingTarget: jest.fn(async () => {
        throw Object.assign(new Error('unregistered'), { code: '4003' });
      }),
    };
    svc.getProductsForBilling = jest.fn();
    await expect(svc.getProducts(account, ctx, undefined, 'unknown')).rejects.toMatchObject({ code: '4003' });
    expect(svc.getProductsForBilling).not.toHaveBeenCalled();
  });
});
