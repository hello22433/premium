import { ICompareCondition } from '../../user_discount/interface/compare.condition';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { IUserDiscountCategory } from '../../user_discount/interface/user.discount.category';
import { IUserDiscountMethod } from '../../user_discount/interface/user.discount.method';
import { IPartnerDiscountChangeType } from '../interface/partner.discount.change.type';
import {
  PartnerDiscountHistoryInterval,
  PricingProductSnapshot,
  resolvePricingAt,
} from './partner.settle.pricing';

const SNAPSHOT: PricingProductSnapshot = {
  price: 10_000,
  category: '모바일쿠폰',
  classificationId: 7,
  brandNameKorean: '스타벅스',
};

let nextId = 1;

function groupInterval(
  overrides: Partial<PartnerDiscountHistoryInterval> = {},
): PartnerDiscountHistoryInterval {
  return {
    id: nextId++,
    scopeKey: 'sk1|1|PRODUCT_GROUP|-|BULK|-|모바일쿠폰|-|ALL',
    category: IUserDiscountCategory.PRODUCT_GROUP,
    classificationId: null,
    method: IUserDiscountMethod.BULK,
    primaryCategory: null,
    group: '모바일쿠폰',
    range: null,
    compareCondition: ICompareCondition.ALL,
    changeType: IPartnerDiscountChangeType.CREATE,
    pricePercent: 5,
    priceAdjustment: IPriceAdjustment.DISCOUNT,
    validFrom: new Date(2026, 4, 1),
    validTo: null,
    ...overrides,
  };
}

describe('시점 매입율 판정 (§8.2 판정 술어)', () => {
  it('케이스 1 — 이력이 전혀 없으면 정당한 무매칭 0%·NORMAL 이다', () => {
    const outcome = resolvePricingAt(new Date(2026, 5, 9), SNAPSHOT, []);
    expect(outcome).toEqual({
      status: 'NORMAL',
      pricingResolution: 'NO_MATCH',
      pricePercent: 0,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      appliedDiscountHistoryId: null,
    });
  });

  it('케이스 2a — 최초 validFrom 이전(pre-config) 지연 유입도 0%·NORMAL 이다', () => {
    const outcome = resolvePricingAt(new Date(2026, 3, 20), SNAPSHOT, [groupInterval()]);
    expect(outcome.status).toBe('NORMAL');
    if (outcome.status === 'NORMAL') {
      expect(outcome.pricingResolution).toBe('NO_MATCH');
      expect(outcome.pricePercent).toBe(0);
    }
  });

  it('케이스 2b — 최초 validFrom 이후 내부 hole 은 COVERAGE_GAP 격리다', () => {
    const intervals = [
      groupInterval({ validFrom: new Date(2026, 4, 1), validTo: new Date(2026, 4, 20) }),
      groupInterval({ validFrom: new Date(2026, 5, 1), validTo: null, pricePercent: 10 }),
    ];
    const outcome = resolvePricingAt(new Date(2026, 4, 25), SNAPSHOT, intervals);
    expect(outcome).toMatchObject({ status: 'NEEDS_REVIEW', reviewCode: 'COVERAGE_GAP' });
  });

  it('케이스 3 — 커버 구간이 2개면 비결정이라 격리한다', () => {
    const intervals = [
      groupInterval({ validFrom: new Date(2026, 4, 1), validTo: new Date(2026, 5, 1) }),
      groupInterval({ validFrom: new Date(2026, 4, 15), validTo: null, pricePercent: 10 }),
    ];
    const outcome = resolvePricingAt(new Date(2026, 4, 20), SNAPSHOT, intervals);
    expect(outcome).toMatchObject({ status: 'NEEDS_REVIEW', reviewCode: 'COVERAGE_GAP' });
  });

  it('tombstone 커버는 격리가 아니라 비활성이다 — 활성 scope 가 없으면 0%·NORMAL', () => {
    const intervals = [
      groupInterval({ validFrom: new Date(2026, 4, 1), validTo: new Date(2026, 5, 1) }),
      groupInterval({
        changeType: IPartnerDiscountChangeType.DELETE,
        pricePercent: null,
        priceAdjustment: null,
        validFrom: new Date(2026, 5, 1),
        validTo: null,
      }),
    ];
    const outcome = resolvePricingAt(new Date(2026, 5, 15), SNAPSHOT, intervals);
    expect(outcome).toMatchObject({ status: 'NORMAL', pricingResolution: 'NO_MATCH', pricePercent: 0 });
  });

  it('tombstone 으로 상위 scope 가 비활성이면 하위 우선순위로 fallback 한다', () => {
    const brandScope = 'sk1|1|BRAND|-|BULK|스타벅스|-|-|ALL';
    const intervals = [
      groupInterval({ pricePercent: 5, validFrom: new Date(2026, 4, 1), validTo: null }),
      groupInterval({
        scopeKey: brandScope,
        category: IUserDiscountCategory.BRAND,
        primaryCategory: '스타벅스',
        group: null,
        pricePercent: 9,
        validFrom: new Date(2026, 4, 1),
        validTo: new Date(2026, 5, 1),
      }),
      groupInterval({
        scopeKey: brandScope,
        category: IUserDiscountCategory.BRAND,
        primaryCategory: '스타벅스',
        group: null,
        changeType: IPartnerDiscountChangeType.DELETE,
        pricePercent: null,
        priceAdjustment: null,
        validFrom: new Date(2026, 5, 1),
        validTo: null,
      }),
    ];

    const beforeDelete = resolvePricingAt(new Date(2026, 4, 10), SNAPSHOT, intervals);
    expect(beforeDelete).toMatchObject({ status: 'NORMAL', pricingResolution: 'HISTORY_MATCH', pricePercent: 9 });

    const afterDelete = resolvePricingAt(new Date(2026, 5, 10), SNAPSHOT, intervals);
    expect(afterDelete).toMatchObject({ status: 'NORMAL', pricingResolution: 'HISTORY_MATCH', pricePercent: 5 });
  });

  it('시점별 값 구간을 정확히 고른다 (6/9 = 5%, 6/13 = 10%)', () => {
    const intervals = [
      groupInterval({ pricePercent: 5, validFrom: new Date(2026, 4, 1), validTo: new Date(2026, 5, 10) }),
      groupInterval({ pricePercent: 10, validFrom: new Date(2026, 5, 10), validTo: null }),
    ];
    expect(resolvePricingAt(new Date(2026, 5, 9), SNAPSHOT, intervals)).toMatchObject({ pricePercent: 5 });
    expect(resolvePricingAt(new Date(2026, 5, 13), SNAPSHOT, intervals)).toMatchObject({ pricePercent: 10 });
  });

  it('구간 경계는 validFrom 포함·validTo 제외다', () => {
    const boundary = new Date(2026, 5, 10);
    const intervals = [
      groupInterval({ pricePercent: 5, validFrom: new Date(2026, 4, 1), validTo: boundary }),
      groupInterval({ pricePercent: 10, validFrom: boundary, validTo: null }),
    ];
    expect(resolvePricingAt(boundary, SNAPSHOT, intervals)).toMatchObject({ pricePercent: 10 });
    expect(resolvePricingAt(new Date(boundary.getTime() - 1), SNAPSHOT, intervals)).toMatchObject({
      pricePercent: 5,
    });
  });

  it('매칭 시 근거 history id 를 원장에 되돌려준다', () => {
    const interval = groupInterval({ pricePercent: 5 });
    const outcome = resolvePricingAt(new Date(2026, 5, 9), SNAPSHOT, [interval]);
    expect(outcome).toMatchObject({
      pricingResolution: 'HISTORY_MATCH',
      appliedDiscountHistoryId: interval.id,
    });
  });

  it('카테고리↔상품군 방향 충돌은 throw 가 아니라 POLICY_CONFLICT 격리다', () => {
    const intervals = [
      groupInterval({ pricePercent: 5, priceAdjustment: IPriceAdjustment.DISCOUNT }),
      groupInterval({
        scopeKey: 'sk1|1|CATEGORY|7|BULK|-|-|-|ALL',
        category: IUserDiscountCategory.CATEGORY,
        classificationId: 7,
        group: null,
        pricePercent: 3,
        priceAdjustment: IPriceAdjustment.ADDITIONAL,
      }),
    ];
    const outcome = resolvePricingAt(new Date(2026, 5, 9), SNAPSHOT, intervals);
    expect(outcome).toMatchObject({ status: 'NEEDS_REVIEW', reviewCode: 'POLICY_CONFLICT' });
  });

  it('스냅샷 결손은 live 상품 조회 없이 PRICE_UNRECOVERABLE 격리다', () => {
    const legacy: PricingProductSnapshot = { price: null, category: null, classificationId: null, brandNameKorean: null };
    expect(resolvePricingAt(new Date(2026, 5, 9), legacy, [groupInterval()])).toMatchObject({
      status: 'NEEDS_REVIEW',
      reviewCode: 'PRICE_UNRECOVERABLE',
    });
  });
});
