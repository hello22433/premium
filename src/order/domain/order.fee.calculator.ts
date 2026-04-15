import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';

export const OrderFeeCalculator = (obj: { fee: number; priceAdjustment: IPriceAdjustment; price: number }): number => {
  if (obj.fee === 0) {
    return obj.price;
  }

  if (obj.priceAdjustment === 'DISCOUNT') {
    const total = obj.price - (obj.fee / 100) * obj.price;
    return total;
  }

  if (obj.priceAdjustment === 'ADDITIONAL') {
    return obj.price + (obj.fee / 100) * obj.price;
  }

  throw new Error('Price Adjustment Error');
};

/** 카드할증 비율 (3%) */
export const CARD_SURCHARGE_RATE = 0.03;

/** 카드할증을 적용한 금액 계산 (10원 단위 절사) */
export function applyCardSurcharge(amount: number, applied: boolean): number {
  if (!applied) return amount;
  const total = amount + amount * CARD_SURCHARGE_RATE;
  return Math.floor(total / 10) * 10;
}
