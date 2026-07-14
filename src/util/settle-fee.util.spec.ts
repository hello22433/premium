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

/**
 * D3-52 후속(이기성 재리뷰) — 차등정산 여부(hasDeliveryFee) 판정 기준을 필터 "전"(allDeliveries)으로
 * 통일. 표시 경로(settle.service buildSettlementDisplayLines, PR #533)가 이미 allDeliveries 기준이라
 * 정산금액 util 도 동일 기준으로 맞춰 화면과 정산금액이 서로 다른 분기를 타는 것을 방지한다.
 *
 * 핵심 엣지: 유일하게 settleFee 를 가진 행이 "대체된 CANCEL 원본"이고, 생존 재발행분은 settleFee 를
 * 승계하지 않은(레거시/비CS 경로) 데이터. 필터 후 기준이면 생존에 요율이 없어 균일 분기로 떨어져
 * 단가 × mapping.amount(폐기 포함 수량)로 과다 계산된다. 필터 전 기준이면 차등 분기를 유지해
 * 생존 발송건만 합산한다.
 */
describe('calculateMappingSettlementBaseAmount — 차등 분기 판정은 필터 전 기준 (D3-52 재리뷰)', () => {
  const live = (id: number, settleFee: number | null, over: Record<string, unknown> = {}) => ({
    id,
    settleFee,
    settlePriceAdjustment: settleFee !== null ? IPriceAdjustment.DISCOUNT : null,
    couponStatus: OrderDeliveryCouponStatus.NOT_USED,
    replacedFromId: null,
    ...over,
  });

  it('유일 settleFee 보유 행이 대체된 CANCEL 원본이고 생존분은 요율 미승계 → 차등 분기 유지(생존만 합산)', () => {
    // 3335원, mapping.fee 없음. 행1(요율10, 대체된 CANCEL) + 행3(요율 미승계, 생존, 재발행분)
    const mapping = {
      amount: 2,
      fee: null,
      priceAdjustment: null,
      product: { price: 3335 },
      orderDeliveries: [
        live(1, 10, { couponStatus: OrderDeliveryCouponStatus.CANCEL }), // 유일한 settleFee 보유(폐기 원본)
        live(3, null, { replacedFromId: 1 }), // 생존 재발행분, settleFee 미승계
      ],
    } as any;

    // 필터 전 기준(allDeliveries.some=true) → 차등 분기 → 생존 [행3] 1건만 = 3335(요율 없음, 정가)
    expect(calculateMappingSettlementBaseAmount(mapping)).toBe(3335);
    // 필터 후 기준(옛 동작)이면 균일 분기로 떨어져 3335 × mapping.amount(2) = 6670 이 됐을 것
    expect(calculateMappingSettlementBaseAmount(mapping)).not.toBe(6670);
  });

  it('생존분이 mapping.fee 로 폴백되는 엣지 → 차등 분기에서 생존만 할인 적용(단가×1)', () => {
    // mapping.fee=10 존재. 행1(delivery요율11, 대체 CANCEL) + 행3(settleFee 미승계→mapping.fee 폴백, 생존)
    const mapping = {
      amount: 2,
      fee: 10,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      product: { price: 3335 },
      orderDeliveries: [
        live(1, 11, { couponStatus: OrderDeliveryCouponStatus.CANCEL }),
        live(3, null, { replacedFromId: 1 }),
      ],
    } as any;

    // 차등 분기 → 생존 [행3]: getEffectiveFee = null ?? mapping.fee(10) → 3335-round(333.5)=3001, 1건
    expect(calculateMappingSettlementBaseAmount(mapping)).toBe(3001);
    // 균일 분기(옛 동작)면 3001 × 2 = 6002
    expect(calculateMappingSettlementBaseAmount(mapping)).not.toBe(6002);
  });

  it('생존분이 요율을 정상 승계한 일반 케이스는 판정 기준과 무관하게 동일(회귀 안전)', () => {
    // 행1(요율10, 대체 CANCEL) + 행2(요율11, 생존) + 행3(요율10 승계, 생존 재발행분)
    const mapping = {
      amount: 2,
      fee: null,
      priceAdjustment: null,
      product: { price: 3335 },
      orderDeliveries: [
        live(1, 10, { couponStatus: OrderDeliveryCouponStatus.CANCEL }),
        live(2, 11),
        live(3, 10, { replacedFromId: 1 }),
      ],
    } as any;

    // 필터 전/후 어느 기준이든 생존 [행2,행3] = 2968 + 3001 = 5969
    expect(calculateMappingSettlementBaseAmount(mapping)).toBe(5969);
  });

  it('delivery-level 요율이 전혀 없는 순수 균일 매핑은 필터 전 기준이어도 균일 분기 유지', () => {
    // 대체된 CANCEL 이 있어도 settleFee 가 전부 null → allDeliveries.some=false → 균일 분기
    const mapping = {
      amount: 2,
      fee: 10,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      product: { price: 3335 },
      orderDeliveries: [
        live(1, null, { couponStatus: OrderDeliveryCouponStatus.CANCEL }),
        live(3, null, { replacedFromId: 1 }),
      ],
    } as any;

    // 균일 분기: (3335-round(333.5)=3001) × mapping.amount(2) = 6002 (기존 동작 그대로)
    expect(calculateMappingSettlementBaseAmount(mapping)).toBe(6002);
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
