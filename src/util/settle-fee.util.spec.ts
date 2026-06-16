import {
  calculateMappingSettlementBaseAmount,
  calculateOrderSettlementAmount,
  calculateSettlementPrice,
} from './settle-fee.util';
import { applyCardSurcharge, OrderFeeCalculator } from '../order/domain/order.fee.calculator';
import { IPriceAdjustment } from '../user_discount/interface/price.adjustment';

describe('settle-fee.util 주문 정산금액 계산', () => {
  const createMapping = (overrides: Record<string, unknown> = {}) =>
    ({
      amount: 2,
      fee: 5,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      product: {
        price: 9999,
      },
      orderDeliveries: [],
      ...overrides,
    }) as any;

  it('할인 정산가는 기존 OrderFeeCalculator 기준으로 계산한다', () => {
    const mapping = createMapping({
      amount: 1,
      fee: 5,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      orderDeliveries: [],
    });

    expect(calculateMappingSettlementBaseAmount(mapping)).toBe(9499);
  });

  it('배송별 정산 수수료가 있으면 매핑 수수료보다 배송값을 우선해서 합산한다', () => {
    const mapping = createMapping({
      fee: 5,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      orderDeliveries: [
        {
          settleFee: 5,
          settlePriceAdjustment: IPriceAdjustment.DISCOUNT,
        },
        {
          settleFee: 10,
          settlePriceAdjustment: IPriceAdjustment.DISCOUNT,
        },
      ],
    });

    expect(calculateMappingSettlementBaseAmount(mapping)).toBe(18498);
  });

  it('배송별 정산값이 없으면 매핑 정산값으로 합산한다', () => {
    const mapping = createMapping({
      fee: 5,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      product: {
        price: 10000,
      },
      orderDeliveries: [
        {
          settleFee: null,
          settlePriceAdjustment: null,
        },
        {
          settleFee: null,
          settlePriceAdjustment: null,
        },
      ],
    });

    expect(calculateMappingSettlementBaseAmount(mapping)).toBe(19000);
  });

  it('카드할증은 배송별이 아니라 주문 전체 정산금액에 1회 적용한다', () => {
    const mapping = createMapping({
      amount: 2,
      fee: null,
      priceAdjustment: null,
      orderDeliveries: [
        {
          settleFee: null,
          settlePriceAdjustment: null,
        },
        {
          settleFee: null,
          settlePriceAdjustment: null,
        },
      ],
    });
    const order = {
      cardSurchargeApplied: true,
      orderProductMappings: [mapping],
    } as any;

    expect(calculateOrderSettlementAmount(order)).toBe(applyCardSurcharge(19998, true));
    expect(calculateOrderSettlementAmount(order)).not.toBe(applyCardSurcharge(9999, true) * 2);
  });
});

describe('calculateSettlementPrice — snapshot price priority', () => {
  const makeMapping = (overrides: {
    snapshotProductPrice: number | null;
    productPrice: number;
    fee?: number | null;
    priceAdjustment?: IPriceAdjustment | null;
  }): any => ({
    snapshotProductPrice: overrides.snapshotProductPrice,
    snapshotProductName: null,
    snapshotProductBrandName: null,
    snapshotProductExpireDay: null,
    snapshotProductImagePath: null,
    product: { price: overrides.productPrice, brand: null },
    fee: overrides.fee ?? null,
    priceAdjustment: overrides.priceAdjustment ?? null,
    orderDeliveries: [],
    amount: 1,
  });

  it('snapshot price wins over live product price', () => {
    const mapping = makeMapping({ snapshotProductPrice: 1000, productPrice: 1500 });
    expect(calculateSettlementPrice(mapping, false)).toBe(1000); // must NOT be 1500
  });

  it('legacy null snapshot falls back to live product price', () => {
    const mapping = makeMapping({ snapshotProductPrice: null, productPrice: 1500 });
    expect(calculateSettlementPrice(mapping, false)).toBe(1500);
  });

  it('DISCOUNT fee is applied to snapshot base price', () => {
    const mapping = makeMapping({
      snapshotProductPrice: 1000,
      productPrice: 1500,
      fee: 10,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
    });
    const expected = OrderFeeCalculator({ fee: 10, priceAdjustment: IPriceAdjustment.DISCOUNT, price: 1000 });
    expect(calculateSettlementPrice(mapping, false)).toBe(expected);
  });

  it('ADDITIONAL fee is applied to snapshot base price', () => {
    const mapping = makeMapping({
      snapshotProductPrice: 1000,
      productPrice: 1500,
      fee: 20,
      priceAdjustment: IPriceAdjustment.ADDITIONAL,
    });
    const expected = OrderFeeCalculator({ fee: 20, priceAdjustment: IPriceAdjustment.ADDITIONAL, price: 1000 });
    expect(calculateSettlementPrice(mapping, false)).toBe(expected);
  });

  it('legacy null snapshot: DISCOUNT fee applied to live price', () => {
    const mapping = makeMapping({
      snapshotProductPrice: null,
      productPrice: 1500,
      fee: 10,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
    });
    const expected = OrderFeeCalculator({ fee: 10, priceAdjustment: IPriceAdjustment.DISCOUNT, price: 1500 });
    expect(calculateSettlementPrice(mapping, false)).toBe(expected);
  });
});
