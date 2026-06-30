import { BadRequestException } from '@nestjs/common';
import { UserDiscountEntity } from '../../entity/user.discount.entity';
import { ICompareCondition } from '../interface/compare.condition';
import { findMatchingDiscount } from './discount.matcher';
import { IUserDiscountCategory } from '../interface/user.discount.category';
import { IUserDiscountMethod } from '../interface/user.discount.method';
import { IPriceAdjustment } from '../interface/price.adjustment';

const product = {
  price: 10000,
  category: 'coffee',
  classificationId: 11,
  brand: { nameKorean: '테스트브랜드' },
};

function discount(
  overrides: Partial<UserDiscountEntity> &
    Pick<UserDiscountEntity, 'id' | 'category' | 'priceAdjustment' | 'pricePercent'>,
): UserDiscountEntity {
  return {
    method: IUserDiscountMethod.BULK,
    group: null,
    primaryCategory: null,
    classificationId: null,
    range: null,
    compareCondition: ICompareCondition.ALL,
    ...overrides,
  } as UserDiscountEntity;
}

describe('findMatchingDiscount', () => {
  it('카테고리와 상품군이 같은 방향이면 기존처럼 더 높은 비율을 선택한다', () => {
    const category = discount({
      id: 1,
      category: IUserDiscountCategory.CATEGORY,
      classificationId: product.classificationId,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      pricePercent: 5,
    });
    const group = discount({
      id: 2,
      category: IUserDiscountCategory.PRODUCT_GROUP,
      group: product.category,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      pricePercent: 10,
    });

    expect(findMatchingDiscount(product, [category, group])).toBe(group);
  });

  it('카테고리와 상품군의 할인/할증 방향이 다르면 정책 충돌로 실패한다', () => {
    const category = discount({
      id: 1,
      category: IUserDiscountCategory.CATEGORY,
      classificationId: product.classificationId,
      priceAdjustment: IPriceAdjustment.ADDITIONAL,
      pricePercent: 5,
    });
    const group = discount({
      id: 2,
      category: IUserDiscountCategory.PRODUCT_GROUP,
      group: product.category,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      pricePercent: 3,
    });

    expect(() => findMatchingDiscount(product, [category, group])).toThrow(BadRequestException);
  });
});
