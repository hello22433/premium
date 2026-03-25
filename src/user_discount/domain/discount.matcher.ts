import { UserDiscountEntity } from '../../entity/user.discount.entity';
import { IUserDiscountCategory } from '../interface/user.discount.category';
import { IUserDiscountMethod } from '../interface/user.discount.method';
import { ICompareCondition } from '../interface/compare.condition';

type DiscountMatchProduct = {
  price: number;
  category: string;
  brand?: { nameKorean: string } | null;
};

/**
 * 상품에 매칭되는 할인 규칙 찾기
 * 우선순위: 브랜드(CLASSIFICATION) > 상품군(CATEGORY)
 * 브랜드 할인 규칙이 존재하면 상품군으로 폴백하지 않음
 */
export function findMatchingDiscount(
  product: DiscountMatchProduct,
  userDiscounts: UserDiscountEntity[],
  priceOverride?: number,
): UserDiscountEntity | null {
  if (!userDiscounts || userDiscounts.length === 0) {
    return null;
  }

  const brandDiscounts = userDiscounts.filter(
    (d) =>
      d.category === IUserDiscountCategory.CLASSIFICATION &&
      d.primaryCategory === product.brand?.nameKorean,
  );

  if (brandDiscounts.length > 0) {
    return findDiscountByMethod(product, brandDiscounts, priceOverride);
  }

  const categoryDiscounts = userDiscounts.filter(
    (d) =>
      d.category === IUserDiscountCategory.CATEGORY &&
      d.group === product.category,
  );

  return findDiscountByMethod(product, categoryDiscounts, priceOverride);
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
