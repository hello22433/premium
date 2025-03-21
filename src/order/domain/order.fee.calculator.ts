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
