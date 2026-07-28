import { ExternalApiService } from './external.api.service';
import { IUserDiscountCategory } from '../../user_discount/interface/user.discount.category';
import { IUserDiscountMethod } from '../../user_discount/interface/user.discount.method';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserSettleMethod } from '../../user/interface/user.settle.method';
import { WalletCutoverMode } from '../../wallet/config/wallet-cutover.config';

/**
 * D3-48 ② — getProductsForBilling 의 salePrice 가 주문 정산(createOrder)과 동일 모델
 * (할인 findMatchingDiscount + 카드할증)로 산출되는지 검증.
 *
 * 이전: salePrice = p.price (정가, 할인 미적용) → 카탈로그 표시값이 실제 청구단가와 불일치.
 * 본 수정: computeUnitSettlement 공유로 createOrder 와 동일 단가를 노출.
 *
 * - 할인은 userId 조건만 배치 로딩. 협력사 정산 수수료(partnerCompanyId 기준)는
 *   자사↔협력사 간 정산이므로 고객사 salePrice 산출 대상이 아니다.
 */
describe('ExternalApiService.getProductsForBilling — salePrice 할인/카드할증 적용 (D3-48 ②)', () => {
  const makeQb = (products: unknown[]) => {
    const qb: any = {};
    for (const m of ['leftJoinAndSelect', 'innerJoin', 'where', 'andWhere']) qb[m] = jest.fn(() => qb);
    qb.getMany = jest.fn(async () => products);
    return qb;
  };

  // SUPER_ADMIN 으로 두어 getAssignedProductIds 경로를 건너뛰고 qb 픽스처를 그대로 사용.
  const makeUser = (settleMethod: IUserSettleMethod | 'BANK' = 'BANK') =>
    ({ id: 42, authority: IUserAuthority.SUPER_ADMIN, company: { settleMethod } }) as any;

  const makeProduct = (overrides: Record<string, unknown> = {}) =>
    ({
      code: 'EP0001',
      name: '상품A',
      brand: { nameKorean: '브랜드A' },
      price: 10000,
      imagePath: 'http://img',
      expireDay: 90,
      type: 'GENERAL',
      memo: '발송 안내문',
      isCancelable: true,
      partnerCompanyId: 1,
      category: 'GENERAL',
      classificationId: 100,
      ...overrides,
    }) as any;

  // BULK·PRODUCT_GROUP·DISCOUNT 10% — 구간 계산 없이 결정적으로 매칭되는 최소 할인.
  const groupDiscount = (overrides: Record<string, unknown> = {}) =>
    ({
      userId: 42,
      partnerCompanyId: null,
      category: IUserDiscountCategory.PRODUCT_GROUP,
      group: 'GENERAL',
      method: IUserDiscountMethod.BULK,
      pricePercent: 10,
      priceAdjustment: 'DISCOUNT',
      ...overrides,
    }) as any;

  const makeSvc = (
    products: unknown[],
    discounts: unknown[],
    opts?: { mode?: WalletCutoverMode; walletSettleMethod?: 'CARD' | 'CASH'; walletCardSurchargeApplied?: boolean },
  ) => {
    const svc = Object.create(ExternalApiService.prototype) as any;
    // §9 컷오버 게이트 — 단위 테스트 기본값은 '미전환 건'(legacy 경로 그대로 통과).
    (svc as any).cutoverGuard = {
      assertLegacyAllowed: jest.fn().mockResolvedValue(undefined),
      assertRefundExecutionAllowed: jest.fn().mockResolvedValue(undefined),
      isCutover: jest.fn().mockResolvedValue(false),
      splitLegacyAllowed: jest.fn(async (ids: number[]) => ({ allowed: ids, blocked: [] })),
    };
    svc.productRepository = { createQueryBuilder: jest.fn(() => makeQb(products)) };
    // userId 조건 필터를 시뮬레이션: where.userId 와 일치하는 항목만 반환.
    svc.userDiscountRepository = {
      find: jest.fn(async ({ where }: { where: { userId: number } }) =>
        discounts.filter((d: any) => d.userId === where.userId),
      ),
    };
    // 카드할증 정산방법 소스: 기본 LEGACY(회사값). WALLET 모드면 정산코드 wallet.settleMethod.
    svc.walletCutoverConfig = { pr3SettleMode: opts?.mode ?? WalletCutoverMode.LEGACY };
    svc.walletAccountResolverService = {
      resolveByUserId: jest.fn(async () => ({
        settleMethod: opts?.walletSettleMethod ?? 'CASH',
        cardSurchargeApplied: opts?.walletCardSurchargeApplied ?? true,
      })),
    };
    return svc;
  };

  it('할인 없음 → salePrice = price (정가 그대로)', async () => {
    const svc = makeSvc([makeProduct()], []);

    const res = await svc.getProductsForBilling(makeUser());

    expect(res.data[0].price).toBe(10000);
    expect(res.data[0].salePrice).toBe(10000);
  });

  it('user 할인(10% DISCOUNT) → salePrice = 9000 (price=10000 유지)', async () => {
    const svc = makeSvc([makeProduct()], [groupDiscount()]);

    const res = await svc.getProductsForBilling(makeUser());

    expect(res.data[0].price).toBe(10000);
    expect(res.data[0].salePrice).toBe(9000); // 10000 - round(10%·10000)
  });

  it('카드할증(company.settleMethod=CARD) → salePrice = 9270 (9000 + 3% 가산, 10원 절사)', async () => {
    const svc = makeSvc([makeProduct()], [groupDiscount()]);

    const res = await svc.getProductsForBilling(makeUser(IUserSettleMethod.CARD));

    expect(res.data[0].salePrice).toBe(9270);
  });

  it('WALLET 모드 → 카드할증은 회사값이 아닌 정산코드 wallet.settleMethod 기준 (company=BANK·wallet=CARD → 할증)', async () => {
    const svc = makeSvc([makeProduct()], [groupDiscount()], {
      mode: WalletCutoverMode.WALLET,
      walletSettleMethod: 'CARD',
    });
    const res = await svc.getProductsForBilling(makeUser('BANK')); // 회사는 비카드
    expect(res.data[0].salePrice).toBe(9270); // 코드 지갑=CARD → 할증 적용
  });

  it('WALLET 모드 → wallet=CARD 라도 정산코드 카드할증 토글 OFF면 할증 없음', async () => {
    const svc = makeSvc([makeProduct()], [groupDiscount()], {
      mode: WalletCutoverMode.WALLET,
      walletSettleMethod: 'CARD',
      walletCardSurchargeApplied: false,
    });
    const res = await svc.getProductsForBilling(makeUser('BANK'));
    expect(res.data[0].salePrice).toBe(9000); // wallet CARD 지만 토글 OFF → 할증 없음
  });

  it('WALLET 모드 → wallet=CASH면 회사가 CARD여도 할증 없음', async () => {
    const svc = makeSvc([makeProduct()], [groupDiscount()], {
      mode: WalletCutoverMode.WALLET,
      walletSettleMethod: 'CASH',
    });
    const res = await svc.getProductsForBilling(makeUser(IUserSettleMethod.CARD)); // 회사는 CARD
    expect(res.data[0].salePrice).toBe(9000); // 코드 지갑=CASH → 할증 없음
  });

  it('협력사 정산 수수료(partnerCompanyId 전용 할인)는 고객사 salePrice에 적용되지 않는다', async () => {
    const products = [
      makeProduct({ code: 'EP-P1', partnerCompanyId: 1 }),
      makeProduct({ code: 'EP-P2', partnerCompanyId: 2 }),
    ];
    // userId 없이 partnerCompanyId 에만 걸린 할인 = 협력사 정산 수수료 → 고객사 salePrice 미적용
    const discounts = [groupDiscount({ userId: null, partnerCompanyId: 2 })];
    const svc = makeSvc(products, discounts);

    const res = await svc.getProductsForBilling(makeUser());
    const byCode = Object.fromEntries(res.data.map((d: any) => [d.productCode, d.salePrice]));

    expect(byCode['EP-P1']).toBe(10000); // 협력사 수수료 미적용 → 정가
    expect(byCode['EP-P2']).toBe(10000); // 협력사 수수료 미적용 → 정가
  });
});
