import {
  calculateMappingSettlementBaseAmount,
  calculateOrderSettlementAmount,
  calculateSettlementPrice,
} from './settle-fee.util';
import { applyCardSurcharge, OrderFeeCalculator } from '../order/domain/order.fee.calculator';
import { IPriceAdjustment } from '../user_discount/interface/price.adjustment';
import { OrderDeliveryCouponStatus } from '../delivery/interface/order.delivery.coupon.status';

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

/**
 * D3-52 — 폐기 후 신규발송(재발행)은 원본 delivery를 지우지 않고 같은 매핑에 새 행을 추가하므로
 * (couponStatus=CANCEL 원본 + replacedFromId로 원본을 가리키는 재발행분 공존),
 * 차등정산(delivery.settleFee) 합산 분기에서 대체된 CANCEL 원본을 제외하지 않으면 이중합산된다.
 * 폐기만 하고 재발행하지 않은 CANCEL 행은 기존 동작(합산 유지)을 보존한다 — 정산 반영 정책 별도 판단.
 */
describe('calculateMappingSettlementBaseAmount — 폐기 재발행 이중합산 방지 (D3-52)', () => {
  // 3335원 상품 2건: 발송건1=10% 할인(3001), 발송건2=11% 할인(2968) → 정상 라인총액 5969
  const makeDiffMapping = (orderDeliveries: Record<string, unknown>[]) =>
    ({
      amount: 2,
      fee: null,
      priceAdjustment: null,
      product: { price: 3335 },
      orderDeliveries,
    }) as any;

  const live = (id: number, settleFee: number, over: Record<string, unknown> = {}) => ({
    id,
    settleFee,
    settlePriceAdjustment: IPriceAdjustment.DISCOUNT,
    couponStatus: OrderDeliveryCouponStatus.NOT_USED,
    replacedFromId: null,
    ...over,
  });

  it('재발행으로 대체된 CANCEL 원본은 합산에서 제외한다 (5969, 이중합산이면 8970)', () => {
    const mapping = makeDiffMapping([
      live(1, 10, { couponStatus: OrderDeliveryCouponStatus.CANCEL }), // 폐기된 원본
      live(2, 11),
      live(3, 10, { replacedFromId: 1 }), // 재발행분(원본 요율 승계)
    ]);

    expect(calculateMappingSettlementBaseAmount(mapping)).toBe(5969);
  });

  it('연쇄 재발행(원본→재발행1→재발행2)은 최종 생존분만 합산한다', () => {
    const mapping = makeDiffMapping([
      live(1, 10, { couponStatus: OrderDeliveryCouponStatus.CANCEL }),
      live(3, 10, { couponStatus: OrderDeliveryCouponStatus.CANCEL, replacedFromId: 1 }),
      live(5, 10, { replacedFromId: 3 }),
      live(2, 11),
    ]);

    expect(calculateMappingSettlementBaseAmount(mapping)).toBe(5969);
  });

  it('bigint hydration: replacedFromId가 string으로 와도 제외된다', () => {
    const mapping = makeDiffMapping([
      live(1, 10, { couponStatus: OrderDeliveryCouponStatus.CANCEL }),
      live(2, 11),
      live(3, 10, { replacedFromId: '1' }),
    ]);

    expect(calculateMappingSettlementBaseAmount(mapping)).toBe(5969);
  });

  it('폐기만 하고 재발행하지 않은 CANCEL 행은 기존대로 합산을 유지한다 (동작 보존)', () => {
    const mapping = makeDiffMapping([
      live(1, 10, { couponStatus: OrderDeliveryCouponStatus.CANCEL }), // 아무도 replacedFromId로 참조 안 함
      live(2, 11),
    ]);

    // CANCEL 전체 필터가 아님을 고정: 3001 + 2968 (전체 필터였다면 2968)
    expect(calculateMappingSettlementBaseAmount(mapping)).toBe(5969);
  });

  it('REFUND_CANCEL(수령 고객 환불)은 재발행 참조가 있어도 고객사 정산에 유지된다 (CANCEL만 제외 대상)', () => {
    const mapping = makeDiffMapping([
      live(1, 10, { couponStatus: OrderDeliveryCouponStatus.REFUND_CANCEL }),
      live(2, 11),
      live(3, 10, { replacedFromId: 1 }), // 참조가 있어도 CANCEL이 아니면 제외하지 않음
    ]);

    // 3001(REFUND_CANCEL 유지) + 2968 + 3001 — 정산확정 경로(L3353 정책)와 동일하게 100% 유지
    expect(calculateMappingSettlementBaseAmount(mapping)).toBe(8970);
  });

  it('균일 요율(fallback 분기)은 재발행 행이 있어도 mapping.amount 기반이라 영향 없다', () => {
    const mapping = {
      amount: 2,
      fee: 5,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      product: { price: 10000 },
      orderDeliveries: [
        live(1, null as unknown as number, {
          settleFee: null,
          settlePriceAdjustment: null,
          couponStatus: OrderDeliveryCouponStatus.CANCEL,
        }),
        live(2, null as unknown as number, { settleFee: null, settlePriceAdjustment: null }),
        live(3, null as unknown as number, { settleFee: null, settlePriceAdjustment: null, replacedFromId: 1 }),
      ],
    } as any;

    expect(calculateMappingSettlementBaseAmount(mapping)).toBe(19000);
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
