import {
  buildSettlementDisplayLines,
  calculateMappingSettlementBaseAmount,
  calculateOrderSettlementAmount,
  calculateSettlementPrice,
  computeSettleNetAmountByOrder,
} from './settle-fee.util';
import { applyCardSurcharge, OrderFeeCalculator } from '../order/domain/order.fee.calculator';
import { IPriceAdjustment } from '../user_discount/interface/price.adjustment';
import { OrderDeliveryCouponStatus } from '../delivery/interface/order.delivery.coupon.status';
import { IOrderDeliveryStatus } from '../delivery/interface/order.delivery.status';

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

/**
 * buildSettlementDisplayLines — 정산 표시용 라인 구성 (D3-49 B안, 요율별 행 분리).
 *
 * 고객사별정산 상세/다중상세와 거래명세서가 공유하는 단일 소스이므로 util 레벨에서 직접 검증한다.
 * 핵심 계약 2가지:
 *   (1) 모든 행의 단가가 "실존값" — price * amount 가 항상 정확한 합계 (평균단가 근사 없음)
 *   (2) 표시 합계 === 돈(calculateMappingSettlementBaseAmount) — 두 함수가 동일 기준(D3-52 필터 포함)
 */
describe('buildSettlementDisplayLines — 요율별 행 분리 (D3-49)', () => {
  const makeDelivery = (over: Record<string, unknown> = {}) =>
    ({
      id: 1,
      settleFee: null,
      settlePriceAdjustment: null,
      couponStatus: OrderDeliveryCouponStatus.NOT_USED,
      replacedFromId: null,
      ...over,
    }) as any;

  const makeMapping = (orderDeliveries: any[], over: Record<string, unknown> = {}) =>
    ({
      amount: 2,
      fee: null,
      priceAdjustment: null,
      product: { price: 3335 },
      orderDeliveries,
      ...over,
    }) as any;

  /** 표시 합계와 돈이 항상 같아야 한다 — 두 경로가 갈라지면 여기서 깨진다. */
  const expectMatchesSettlement = (mapping: any) => {
    const displaySum = buildSettlementDisplayLines(mapping).reduce((s, l) => s + l.price * l.amount, 0);
    expect(displaySum).toBe(calculateMappingSettlementBaseAmount(mapping));
  };

  it('빈 orderDeliveries → 균일 분기 단일 행, amount 는 mapping.amount', () => {
    const mapping = makeMapping([], { fee: 10, priceAdjustment: IPriceAdjustment.DISCOUNT });

    expect(buildSettlementDisplayLines(mapping)).toEqual([{ price: 3001, amount: 2 }]);
    expectMatchesSettlement(mapping);
  });

  it('할인 정보 없음(fee=null) → 정가 단일 행', () => {
    const mapping = makeMapping([makeDelivery({ id: 1 }), makeDelivery({ id: 2 })]);

    expect(buildSettlementDisplayLines(mapping)).toEqual([{ price: 3335, amount: 2 }]);
    expectMatchesSettlement(mapping);
  });

  it('ADDITIONAL(할증) 차등 요율도 단가별로 행이 분리된다', () => {
    // 3335 + round(10%) = 3669 / 3335 + round(11%) = 3702
    const mapping = makeMapping([
      makeDelivery({ id: 1, settleFee: 10, settlePriceAdjustment: IPriceAdjustment.ADDITIONAL }),
      makeDelivery({ id: 2, settleFee: 11, settlePriceAdjustment: IPriceAdjustment.ADDITIONAL }),
    ]);

    expect(buildSettlementDisplayLines(mapping)).toEqual(
      expect.arrayContaining([
        { price: 3669, amount: 1 },
        { price: 3702, amount: 1 },
      ]),
    );
    expectMatchesSettlement(mapping);
  });

  it('같은 요율 발송건은 한 행으로 묶이고 건수가 누적된다', () => {
    const mapping = makeMapping(
      [
        makeDelivery({ id: 1, settleFee: 10, settlePriceAdjustment: IPriceAdjustment.DISCOUNT }),
        makeDelivery({ id: 2, settleFee: 10, settlePriceAdjustment: IPriceAdjustment.DISCOUNT }),
        makeDelivery({ id: 3, settleFee: 11, settlePriceAdjustment: IPriceAdjustment.DISCOUNT }),
      ],
      { amount: 3 },
    );

    expect(buildSettlementDisplayLines(mapping)).toEqual(
      expect.arrayContaining([
        { price: 3001, amount: 2 },
        { price: 2968, amount: 1 },
      ]),
    );
    expectMatchesSettlement(mapping);
  });

  it('폐기만 하고 재발행하지 않은 CANCEL 은 계속 집계에 포함된다 (기존 동작 유지)', () => {
    const mapping = makeMapping([
      makeDelivery({ id: 1, settleFee: 10, settlePriceAdjustment: IPriceAdjustment.DISCOUNT }),
      // CANCEL 이지만 이를 대체한 신행이 없다 → 제외 대상 아님
      makeDelivery({
        id: 2,
        settleFee: 10,
        settlePriceAdjustment: IPriceAdjustment.DISCOUNT,
        couponStatus: OrderDeliveryCouponStatus.CANCEL,
      }),
    ]);

    expect(buildSettlementDisplayLines(mapping)).toEqual([{ price: 3001, amount: 2 }]);
    expectMatchesSettlement(mapping);
  });

  it('폐기 후 재발행으로 대체된 CANCEL 원본은 제외된다 (이중합산 방지)', () => {
    const mapping = makeMapping([
      makeDelivery({
        id: 1,
        settleFee: 10,
        settlePriceAdjustment: IPriceAdjustment.DISCOUNT,
        couponStatus: OrderDeliveryCouponStatus.CANCEL,
      }),
      makeDelivery({ id: 2, settleFee: 10, settlePriceAdjustment: IPriceAdjustment.DISCOUNT, replacedFromId: 1 }),
    ]);

    expect(buildSettlementDisplayLines(mapping)).toEqual([{ price: 3001, amount: 1 }]);
    expectMatchesSettlement(mapping);
  });

  it('replacedFromId 가 string 으로 hydrate 돼도 원본이 제외된다 (bigint → Number 정규화)', () => {
    // TypeORM bigint 컬럼은 런타임에 string 으로 올라올 수 있다. Number() 정규화가 빠지면
    // '1' !== 1 로 매칭에 실패해 CANCEL 원본이 살아남고 조용히 이중청구된다.
    const mapping = makeMapping([
      makeDelivery({
        id: 1,
        settleFee: 10,
        settlePriceAdjustment: IPriceAdjustment.DISCOUNT,
        couponStatus: OrderDeliveryCouponStatus.CANCEL,
      }),
      makeDelivery({ id: 2, settleFee: 10, settlePriceAdjustment: IPriceAdjustment.DISCOUNT, replacedFromId: '1' }),
    ]);

    expect(buildSettlementDisplayLines(mapping)).toEqual([{ price: 3001, amount: 1 }]);
    expectMatchesSettlement(mapping);
  });

  it('차등 분기의 수량은 mapping.amount 가 아니라 실제 과금 발송건 수다', () => {
    // 주문 수량 5 이지만 살아있는 과금 발송건은 2 → 행 수량 합은 2
    const mapping = makeMapping(
      [
        makeDelivery({ id: 1, settleFee: 10, settlePriceAdjustment: IPriceAdjustment.DISCOUNT }),
        makeDelivery({ id: 2, settleFee: 11, settlePriceAdjustment: IPriceAdjustment.DISCOUNT }),
      ],
      { amount: 5 },
    );

    const lines = buildSettlementDisplayLines(mapping);
    expect(lines.reduce((s, l) => s + l.amount, 0)).toBe(2);
    expectMatchesSettlement(mapping);
  });

  it('차등 판정은 필터 "전" 목록 기준 — 유일한 settleFee 보유 행이 대체된 CANCEL 원본이어도 돈과 분기가 일치', () => {
    // settleFee 를 가진 유일한 행이 제외 대상(CANCEL 원본)이고, 생존 신행은 settleFee 미승계.
    // 판정을 필터 후로 하면 표시는 균일 분기, 돈은 차등 분기로 갈라진다 → 반드시 일치해야 한다.
    const mapping = makeMapping(
      [
        makeDelivery({
          id: 1,
          settleFee: 10,
          settlePriceAdjustment: IPriceAdjustment.DISCOUNT,
          couponStatus: OrderDeliveryCouponStatus.CANCEL,
        }),
        makeDelivery({ id: 2, replacedFromId: 1 }),
      ],
      { fee: 20, priceAdjustment: IPriceAdjustment.DISCOUNT },
    );

    expectMatchesSettlement(mapping);
  });
});

describe('computeSettleNetAmountByOrder — 주문별 netAmount 집계 (카드할증 1회)', () => {
  const makeDelivery = (over: {
    orderId: number;
    cardSurchargeApplied: boolean;
    price?: number;
    status?: IOrderDeliveryStatus;
    couponStatus?: OrderDeliveryCouponStatus;
  }): any => ({
    id: `${over.orderId}-${Math.random()}`,
    status: over.status ?? IOrderDeliveryStatus.COMPLETE,
    couponStatus: over.couponStatus ?? OrderDeliveryCouponStatus.NOT_USED,
    settleFee: null,
    settlePriceAdjustment: null,
    orderProductMapping: {
      snapshotProductPrice: over.price ?? 3335,
      product: { price: over.price ?? 3335 },
      fee: null,
      priceAdjustment: null,
      orderDeliveries: [],
      amount: 1,
      order: { id: over.orderId, cardSurchargeApplied: over.cardSurchargeApplied },
    },
  });

  it('카드할증은 발송건별이 아니라 주문 합계에 1회 적용된다 (비선형 차이 방지)', () => {
    const deliveries = [
      makeDelivery({ orderId: 1, cardSurchargeApplied: true }),
      makeDelivery({ orderId: 1, cardSurchargeApplied: true }),
    ];

    const net = computeSettleNetAmountByOrder(deliveries);

    expect(net.get(1)).toBe(applyCardSurcharge(6670, true)); // 6870 = 합계 1회 적용
    // 발송건별 적용(레거시 버그 경로)이면 3430 + 3430 = 6860 이 됐을 것
    expect(net.get(1)).not.toBe(applyCardSurcharge(3335, true) * 2);
  });

  it('비카드 주문은 base 합계 그대로 (경로 A·B 동일)', () => {
    const deliveries = [
      makeDelivery({ orderId: 2, cardSurchargeApplied: false }),
      makeDelivery({ orderId: 2, cardSurchargeApplied: false }),
    ];

    expect(computeSettleNetAmountByOrder(deliveries).get(2)).toBe(6670);
  });

  it('COMPLETE/COMPLETE_SMS 아니거나 CANCEL 폐기건은 제외, REFUND_CANCEL 은 포함', () => {
    const deliveries = [
      makeDelivery({ orderId: 3, cardSurchargeApplied: false }), // 포함 3335
      makeDelivery({ orderId: 3, cardSurchargeApplied: false, status: IOrderDeliveryStatus.WAIT }), // 제외
      makeDelivery({ orderId: 3, cardSurchargeApplied: false, couponStatus: OrderDeliveryCouponStatus.CANCEL }), // 제외
      makeDelivery({
        orderId: 3,
        cardSurchargeApplied: false,
        couponStatus: OrderDeliveryCouponStatus.REFUND_CANCEL,
      }), // 포함 3335
      makeDelivery({ orderId: 3, cardSurchargeApplied: false, status: IOrderDeliveryStatus.COMPLETE_SMS }), // 포함 3335
    ];

    expect(computeSettleNetAmountByOrder(deliveries).get(3)).toBe(10005);
  });

  it('여러 주문을 주문별로 분리 집계한다', () => {
    const deliveries = [
      makeDelivery({ orderId: 10, cardSurchargeApplied: false }),
      makeDelivery({ orderId: 11, cardSurchargeApplied: false }),
      makeDelivery({ orderId: 11, cardSurchargeApplied: false }),
    ];

    const net = computeSettleNetAmountByOrder(deliveries);

    expect(net.get(10)).toBe(3335);
    expect(net.get(11)).toBe(6670);
  });
});
