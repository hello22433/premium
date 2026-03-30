import { UserDiscountEntity } from '../../entity/user.discount.entity';
import { IUserDiscountCategory } from '../interface/user.discount.category';
import { IUserDiscountMethod } from '../interface/user.discount.method';
import { ICompareCondition } from '../interface/compare.condition';

type DiscountMatchProduct = {
  price: number;
  category: string;
  classificationId?: number | null;
  brand?: { nameKorean: string } | null;
};

/**
 * 상품에 매칭되는 할인 규칙 찾기
 * 우선순위: 브랜드(BRAND) > 카테고리(CATEGORY) = 상품군(PRODUCT_GROUP)
 * - 브랜드 할인이 구간 일치하면 브랜드 할인 적용
 * - 브랜드 할인이 없거나 구간 불일치 시 카테고리/상품군 폴백
 * - 카테고리/상품군 둘 다 매칭 시 더 높은 할인율 적용
 */
export function findMatchingDiscount(
  product: DiscountMatchProduct,
  userDiscounts: UserDiscountEntity[],
  priceOverride?: number,
): UserDiscountEntity | null {
  if (!userDiscounts || userDiscounts.length === 0) {
    return null;
  }

  // 1. 브랜드 할인 (최우선)
  const brandDiscounts = userDiscounts.filter(
    (d) =>
      d.category === IUserDiscountCategory.BRAND &&
      d.primaryCategory === product.brand?.nameKorean,
  );
  const brandMatch = findDiscountByMethod(product, brandDiscounts, priceOverride);
  if (brandMatch) return brandMatch;

  // 2. 카테고리 + 상품군 동시 매칭 → 높은 할인율
  const categoryDiscounts = userDiscounts.filter(
    (d) =>
      d.category === IUserDiscountCategory.CATEGORY &&
      d.classificationId === product.classificationId,
  );
  const categoryMatch = findDiscountByMethod(product, categoryDiscounts, priceOverride);

  const groupDiscounts = userDiscounts.filter(
    (d) =>
      d.category === IUserDiscountCategory.PRODUCT_GROUP &&
      d.group === product.category,
  );
  const groupMatch = findDiscountByMethod(product, groupDiscounts, priceOverride);

  if (categoryMatch && groupMatch) {
    return categoryMatch.pricePercent >= groupMatch.pricePercent ? categoryMatch : groupMatch;
  }
  return categoryMatch || groupMatch || null;
}

/**
 * 주어진 할인 목록에서 BULK → SECTION 순으로 매칭 시도
 */
function findDiscountByMethod(
  product: DiscountMatchProduct,
  discounts: UserDiscountEntity[],
  priceOverride?: number,
): UserDiscountEntity | null {
  if (discounts.length === 0) {
    return null;
  }

  const bulkDiscount = discounts.find((d) => d.method === IUserDiscountMethod.BULK);
  if (bulkDiscount) {
    return bulkDiscount;
  }

  const sectionDiscounts = discounts.filter(
    (d) => d.method === IUserDiscountMethod.SECTION && d.range,
  );

  if (sectionDiscounts.length === 0) {
    return null;
  }

  const sortedDiscounts = sectionDiscounts.sort((a, b) => {
    return parseInt(a.range || '0', 10) - parseInt(b.range || '0', 10);
  });

  const productPrice = priceOverride ?? product.price;
  let previousUpperBound = 0;

  for (const discount of sortedDiscounts) {
    const rangeValue = parseInt(discount.range || '0', 10);
    let isInRange = false;

    switch (discount.compareCondition) {
      case ICompareCondition.LESS:
        isInRange = productPrice > previousUpperBound && productPrice <= rangeValue;
        break;
      case ICompareCondition.LESS_THAN:
        isInRange = productPrice > previousUpperBound && productPrice < rangeValue;
        break;
      case ICompareCondition.MORE:
        isInRange = productPrice >= rangeValue;
        break;
      case ICompareCondition.MORE_THAN:
        isInRange = productPrice > rangeValue;
        break;
    }

    if (isInRange) {
      return discount;
    }

    if (discount.compareCondition === ICompareCondition.LESS) {
      previousUpperBound = rangeValue;
    } else if (discount.compareCondition === ICompareCondition.LESS_THAN) {
      previousUpperBound = rangeValue - 1;
    }
  }

  return null;
}
