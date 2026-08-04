import { BadRequestException } from '@nestjs/common';
import { UserDiscountEntity } from '../../entity/user.discount.entity';
import { findMatchingDiscount } from '../../user_discount/domain/discount.matcher';
import { IUserDiscountCategory } from '../../user_discount/interface/user.discount.category';
import { IUserDiscountMethod } from '../../user_discount/interface/user.discount.method';
import { ICompareCondition } from '../../user_discount/interface/compare.condition';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { IPartnerDiscountChangeType } from '../interface/partner.discount.change.type';
import { IPartnerSettlePricingResolution, IPartnerSettleReviewCode } from '../interface/partner.settle.source.type';

/**
 * `occurredAt` 시점 매입율 판정 (정본 §8.2 (b) 3-케이스 · §5.10 P10).
 *
 * 전 sourceType 이 **`occurredAt` 시점 `partner_discount_history` 재구성 + `findMatchingDiscount`** 라는
 * 단일 권위를 쓴다. order-time `partnerSettleFee` 스냅샷은 표시·예상용이지 원장 권위가 아니다.
 * matcher 입력(상품군·카테고리·브랜드·정가)만 `order_product_mapping` 불변 스냅샷에서 가져온다
 * (live `product` 조인 금지 — 상품이 바뀌면 과거 정산이 바뀐다).
 *
 * 판정은 **정당한 무매칭(0%)과 이력 손상(gap)을 구분**한다. 손상일 때 현재값으로 fallback 하면
 * 틀린 `settleAmount` 가 조용히 확정되므로, 금액을 비우고 `NEEDS_REVIEW` 로 격리한다.
 * throw 하지 않는 이유는 원장 INSERT 가 상태 전이와 같은 트랜잭션이라 배치 전체가 롤백되기 때문이다.
 */

export type PartnerDiscountHistoryInterval = {
  id: number;
  scopeKey: string;
  category: IUserDiscountCategory;
  classificationId: number | null;
  method: IUserDiscountMethod;
  primaryCategory: string | null;
  group: string | null;
  range: string | null;
  compareCondition: ICompareCondition;
  changeType: IPartnerDiscountChangeType;
  pricePercent: number | null;
  priceAdjustment: IPriceAdjustment | null;
  validFrom: Date;
  validTo: Date | null;
};

/** 원장 계산에 쓰는 주문 라인 불변 스냅샷 (`order_product_mapping`). */
export type PricingProductSnapshot = {
  /** `snapshotProductPrice` — matcher 의 구간(SECTION) 판정 입력 */
  price: number | null;
  /** `snapshotProductCategory` = product.category (상품군) */
  category: string | null;
  /** `snapshotProductClassificationId` = product.classificationId */
  classificationId: number | null;
  /** `snapshotProductBrandName` = brand.nameKorean */
  brandNameKorean: string | null;
};

export type PricingOutcome =
  | {
      status: 'NORMAL';
      pricingResolution: IPartnerSettlePricingResolution;
      pricePercent: number;
      priceAdjustment: IPriceAdjustment;
      appliedDiscountHistoryId: number | null;
    }
  | {
      status: 'NEEDS_REVIEW';
      reviewCode: Extract<
        IPartnerSettleReviewCode,
        'COVERAGE_GAP' | 'POLICY_CONFLICT' | 'PRICE_UNRECOVERABLE'
      >;
      reason: string;
    };

/**
 * @param occurredAt 귀속 시각 (KST naive)
 * @param snapshot   주문 라인 불변 스냅샷
 * @param intervals  해당 협력사의 history 구간 전량(활성·tombstone 모두. superseded/soft-delete 는 제외해서 넘긴다)
 */
export function resolvePricingAt(
  occurredAt: Date,
  snapshot: PricingProductSnapshot,
  intervals: PartnerDiscountHistoryInterval[],
): PricingOutcome {
  if (snapshot.price === null || snapshot.price === undefined || !snapshot.category) {
    return {
      status: 'NEEDS_REVIEW',
      reviewCode: 'PRICE_UNRECOVERABLE',
      reason: '주문 라인 스냅샷(정가·상품군)이 없어 매칭 입력을 복원할 수 없다',
    };
  }

  const byScope = new Map<string, PartnerDiscountHistoryInterval[]>();
  for (const interval of intervals) {
    const bucket = byScope.get(interval.scopeKey);
    if (bucket) bucket.push(interval);
    else byScope.set(interval.scopeKey, [interval]);
  }

  const activeCandidates: PartnerDiscountHistoryInterval[] = [];

  for (const [scopeKey, scopeIntervals] of byScope) {
    const covering = scopeIntervals.filter((interval) => covers(interval, occurredAt));

    // 케이스 3 — 커버 구간 2개 이상. 비결정 상태라 격리한다.
    if (covering.length > 1) {
      return {
        status: 'NEEDS_REVIEW',
        reviewCode: 'COVERAGE_GAP',
        reason: `scope ${scopeKey} 의 구간이 ${occurredAt.toISOString()} 에서 겹친다`,
      };
    }

    if (covering.length === 0) {
      const earliest = Math.min(...scopeIntervals.map((interval) => interval.validFrom.getTime()));
      // 케이스 2a — 최초 설정 이전(pre-config). 매입율 0% 가 사실이므로 격리 대상이 아니다.
      if (occurredAt.getTime() < earliest) continue;
      // 케이스 2b — 연속성 불변식상 나올 수 없는 내부 hole = 이력 손상의 양의 증거.
      return {
        status: 'NEEDS_REVIEW',
        reviewCode: 'COVERAGE_GAP',
        reason: `scope ${scopeKey} 에 ${occurredAt.toISOString()} 를 커버하는 구간이 없다(내부 hole)`,
      };
    }

    const [interval] = covering;
    // tombstone 은 "그 시각 비활성"이라는 정당한 사실이다. 후보에서 빠질 뿐 gap 이 아니다.
    if (interval.changeType === IPartnerDiscountChangeType.DELETE) continue;
    if (interval.pricePercent === null || interval.priceAdjustment === null) {
      return {
        status: 'NEEDS_REVIEW',
        reviewCode: 'COVERAGE_GAP',
        reason: `scope ${scopeKey} 의 값 구간에 percent/adjustment 가 비어 있다`,
      };
    }
    activeCandidates.push(interval);
  }

  const product = {
    price: snapshot.price,
    category: snapshot.category,
    classificationId: snapshot.classificationId,
    brand: snapshot.brandNameKorean ? { nameKorean: snapshot.brandNameKorean } : null,
  };

  let matched: UserDiscountEntity | null;
  try {
    matched = findMatchingDiscount(product, activeCandidates.map(toMatcherCandidate));
  } catch (error) {
    // matcher 는 category↔상품군 방향 충돌에 BadRequestException 을 던진다. 배치를 멈추지 않고 격리한다.
    if (error instanceof BadRequestException) {
      return {
        status: 'NEEDS_REVIEW',
        reviewCode: 'POLICY_CONFLICT',
        reason: '카테고리 할인과 상품군 할인의 방향(할인/할증)이 충돌한다',
      };
    }
    throw error;
  }

  // 케이스 1·2a·tombstone 공백 — 정당한 무매칭. 0% 도 DISCOUNT 로 정규화한다.
  if (!matched) {
    return {
      status: 'NORMAL',
      pricingResolution: 'NO_MATCH',
      pricePercent: 0,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      appliedDiscountHistoryId: null,
    };
  }

  return {
    status: 'NORMAL',
    pricingResolution: 'HISTORY_MATCH',
    pricePercent: matched.pricePercent,
    priceAdjustment: matched.priceAdjustment,
    appliedDiscountHistoryId: matched.id,
  };
}

/** `validFrom ≤ occurredAt < validTo` (validTo NULL = open). */
function covers(interval: PartnerDiscountHistoryInterval, occurredAt: Date): boolean {
  if (interval.validFrom.getTime() > occurredAt.getTime()) return false;
  if (interval.validTo === null) return true;
  return occurredAt.getTime() < interval.validTo.getTime();
}

/**
 * history 구간을 matcher 입력 형상으로 투영한다. **읽기 전용 in-memory 변환**이며
 * `user_discount` 를 직접 읽지 않는다 — 시점 권위는 history 뿐이다.
 * `id` 는 원장 `appliedDiscountHistoryId` 로 되돌아가야 하므로 history row id 를 그대로 싣는다.
 */
function toMatcherCandidate(interval: PartnerDiscountHistoryInterval): UserDiscountEntity {
  return {
    id: interval.id,
    category: interval.category,
    classificationId: interval.classificationId,
    method: interval.method,
    primaryCategory: interval.primaryCategory,
    group: interval.group,
    range: interval.range,
    compareCondition: interval.compareCondition,
    pricePercent: interval.pricePercent as number,
    priceAdjustment: interval.priceAdjustment as IPriceAdjustment,
  } as UserDiscountEntity;
}
