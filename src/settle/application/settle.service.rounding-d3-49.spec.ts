import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { calculateMappingSettlementBaseAmount } from '../../util/settle-fee.util';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';

/**
 * D3-49 — 정산관리 고객사 정산금액(getUserList/Summary/Ids/상세/거래명세서)이 실제 돈과 동일한
 * 단일 함수 calculateMappingSettlementBaseAmount(settleFee 우선 + 단가별 반올림 + 발송건 합산)로
 * 통일됐는지 검증. (옛 calculateMappingSettlePrice 중복 헬퍼는 제거됨 — 이 함수로 수렴)
 *
 * 핵심: 가격 100단위·정수 fee면 표시값 무변동, 비100/소수율/차등 settleFee 에서만 실제 차감과 정합.
 */
describe('settle 정산금액 — calculateMappingSettlementBaseAmount 통일(실경로) (D3-49)', () => {
  const calc = (mapping: Record<string, unknown>): number =>
    calculateMappingSettlementBaseAmount(mapping as unknown as OrderProductMappingEntity);

  const makeMapping = (over: Record<string, unknown> = {}) => ({
    fee: null,
    priceAdjustment: null,
    amount: 1,
    product: { price: 10000, category: 'GENERAL', brand: null },
    orderDeliveries: [],
    ...over,
  });

  const prod = (price: number) => ({ price, category: 'GENERAL', brand: null });

  it('할인 없음 → 정가(productTotalPrice) 반환', () => {
    expect(calc(makeMapping({ product: prod(10000), amount: 1 }))).toBe(10000);
    expect(calc(makeMapping({ product: prod(10000), amount: 2 }))).toBe(20000);
  });

  it('100단위 10% DISCOUNT → 9000 (ceil==round, 변동 없음)', () => {
    expect(calc(makeMapping({ fee: 10, priceAdjustment: IPriceAdjustment.DISCOUNT, product: prod(10000) }))).toBe(9000);
  });

  it('비100 10% DISCOUNT → 3001 (반올림=실제차감, 이전 ceil 이면 3002)', () => {
    // 3335 - round(10%·3335)=round(333.5)=334 = 3001   (ceil(3335·90/100)=ceil(3001.5)=3002)
    expect(calc(makeMapping({ fee: 10, priceAdjustment: IPriceAdjustment.DISCOUNT, product: prod(3335) }))).toBe(3001);
  });

  it('비100 10% ADDITIONAL → 3667 (반올림 가산, 대칭 검증; 이전 ceil 이면 3668)', () => {
    // 3334 + round(10%·3334)=round(333.4)=333 = 3667   (ceil(3334·110/100)=ceil(3667.4)=3668)
    expect(calc(makeMapping({ fee: 10, priceAdjustment: IPriceAdjustment.ADDITIONAL, product: prod(3334) }))).toBe(
      3667,
    );
  });

  it('수량>1 100단위 → 단가별 반올림×수량 = 18000 (집계와 동일)', () => {
    expect(
      calc(makeMapping({ fee: 10, priceAdjustment: IPriceAdjustment.DISCOUNT, amount: 2, product: prod(10000) })),
    ).toBe(18000);
  });

  it('D3-49 축2: 비100 단가·수량2 → 단가별 반올림×수량 = 6002 (집계반올림 6003 아님, 실제 차감과 일치)', () => {
    // 단가별: (3335 - round(333.5)=334)=3001 × 2 = 6002  ← 실제 돈(calculateSettlementPrice×수량)과 동일
    // 집계반올림(옛 버그): round(6670×0.9)=6003
    expect(
      calc(makeMapping({ fee: 10, priceAdjustment: IPriceAdjustment.DISCOUNT, amount: 2, product: prod(3335) })),
    ).toBe(6002);
  });

  it('delivery settleFee 분기(SSG·소수율 2.5%)도 반올림 처리 → 9750', () => {
    // hasDeliveryFee → 단가(10000)에 delivery.settleFee=2.5% DISCOUNT: 10000 - round(250)=250 = 9750
    const m = makeMapping({
      fee: 10,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      product: prod(10000),
      orderDeliveries: [{ settleFee: 2.5, settlePriceAdjustment: IPriceAdjustment.DISCOUNT }],
    });
    expect(calc(m)).toBe(9750);
  });

  it('delivery 분기 다건 합산: 동일 단가 2건 → 2×9750 = 19500', () => {
    const m = makeMapping({
      fee: 10,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      product: prod(10000),
      orderDeliveries: [
        { settleFee: 2.5, settlePriceAdjustment: IPriceAdjustment.DISCOUNT },
        { settleFee: 2.5, settlePriceAdjustment: IPriceAdjustment.DISCOUNT },
      ],
    });
    expect(calc(m)).toBe(19500);
  });
});
