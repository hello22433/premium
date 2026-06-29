import { ExternalApiService } from './external.api.service';
import { ExternalApiAccountEntity } from '../../entity/external.api.account.entity';
import { IUserDiscountCategory } from '../../user_discount/interface/user.discount.category';
import { IUserDiscountMethod } from '../../user_discount/interface/user.discount.method';
import { ICompareCondition } from '../../user_discount/interface/compare.condition';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';

// PR2a G003: add-only billing 위임층 behavior-identity 검증.
// 기존 메서드(account 기반)와 신규 *ForBilling(billingUser 기반)의 단순모드(billingUser=account.user)
// 호출 결과가 동치임을 확인한다. 출력 불변(위임만) 보장.

function makeAccount(): ExternalApiAccountEntity {
  return {
    user: {
      id: 42,
      authority: 'BUSINESS',
      settleMethod: 'CASH',
      company: { settleMethod: 'CASH' },
    },
  } as any;
}

describe('PR2a G003 위임층 behavior-identity', () => {
  describe('getAssignedProductIds → getAssignedProductIdsForBilling', () => {
    function svcWithAssignedIds(productIds: number[]) {
      const svc = Object.create(ExternalApiService.prototype) as ExternalApiService;
      const getMany = jest.fn(async () => productIds.map((id) => ({ productId: id })));
      const qb: any = {
        innerJoin: jest.fn(() => qb),
        select: jest.fn(() => qb),
        where: jest.fn(() => qb),
        andWhere: jest.fn(() => qb),
        getMany,
      };
      (svc as any).syncProductEventMappingRepository = {
        createQueryBuilder: jest.fn(() => qb),
      };
      return svc;
    }

    it('기존 getAssignedProductIds(userId) == getAssignedProductIdsForBilling(userId)', async () => {
      const account = makeAccount();
      const svc = svcWithAssignedIds([100, 200, 300]);

      const legacy = await (svc as any).getAssignedProductIds(account.user.id);
      const billing = await (svc as any).getAssignedProductIdsForBilling(account.user.id);

      expect(billing).toEqual([100, 200, 300]);
      expect(legacy).toEqual(billing);
    });
  });

  describe('computeSettlement → computeSettlementForBilling', () => {
    function svcWithDiscounts() {
      const svc = Object.create(ExternalApiService.prototype) as ExternalApiService;
      (svc as any).userDiscountRepository = {
        find: jest.fn(async () => []),
      };
      return svc;
    }

    const product: any = {
      id: 1,
      price: 30000,
      category: 'CAT',
      classificationId: 10,
      brand: { id: 5 },
      partnerCompanyId: null,
    };

    it('단순모드: computeSettlement(account,...) == computeSettlementForBilling(account.user,...)', async () => {
      const account = makeAccount();
      const svc = svcWithDiscounts();

      const legacy = await (svc as any).computeSettlement(account, product, 30000);
      const billing = await (svc as any).computeSettlementForBilling(account.user, product, 30000, {
        cardSurchargeApplied: (svc as any).resolveCardSurchargeApplied(account),
      });

      expect(legacy).toEqual(billing);
      // 단순모드 정가(할인 없음) + CASH(카드할증 없음) → settleAmount=sendAmount, cardSurchargeApplied=false
      expect(legacy).toEqual({
        fee: null,
        priceAdjustment: null,
        settleAmount: 30000,
        cardSurchargeApplied: false,
      });
    });

    it('appOptions 미지정 시 billingUser 기준 카드할증 재현(동치)', async () => {
      const account = makeAccount();
      (account.user as any).company = { settleMethod: 'CARD' };
      const svc = svcWithDiscounts();

      const legacy = await (svc as any).computeSettlement(account, product, 30000);
      // appOptions 미지정 → 내부에서 billingUser(=account.user) 기준 재현
      const billing = await (svc as any).computeSettlementForBilling(account.user, product, 30000);

      expect(legacy.cardSurchargeApplied).toBe(true);
      expect(legacy).toEqual(billing);
    });

    it('고객사 정산 계산에 협력사 할인 조건을 섞지 않는다', async () => {
      const account = makeAccount();
      const svc = svcWithDiscounts();
      (svc as any).userDiscountRepository.find = jest.fn(async () => [
        {
          id: 1,
          userId: account.user.id,
          partnerCompanyId: null,
          category: IUserDiscountCategory.CATEGORY,
          classificationId: 10,
          method: IUserDiscountMethod.BULK,
          group: null,
          primaryCategory: null,
          range: null,
          compareCondition: ICompareCondition.ALL,
          priceAdjustment: IPriceAdjustment.DISCOUNT,
          pricePercent: 5,
        },
        {
          id: 2,
          userId: null,
          partnerCompanyId: 20,
          category: IUserDiscountCategory.PRODUCT_GROUP,
          classificationId: null,
          method: IUserDiscountMethod.BULK,
          group: 'CAT',
          primaryCategory: null,
          range: null,
          compareCondition: ICompareCondition.ALL,
          priceAdjustment: IPriceAdjustment.ADDITIONAL,
          pricePercent: 10,
        },
      ]);

      const result = await (svc as any).computeSettlementForBilling(
        account.user,
        { ...product, partnerCompanyId: 20 },
        30000,
      );

      expect((svc as any).userDiscountRepository.find).toHaveBeenCalledWith({ where: { userId: account.user.id } });
      expect(result).toEqual({
        fee: 5,
        priceAdjustment: IPriceAdjustment.DISCOUNT,
        settleAmount: 28500,
        cardSurchargeApplied: false,
      });
    });
  });
});
