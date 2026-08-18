import { buildSettlementDisplayLines, calculateMappingSettlementBaseAmount } from './settle-fee.util';
import { IOrderDeliveryStatus } from '../delivery/interface/order.delivery.status';
import { OrderDeliveryCouponStatus } from '../delivery/interface/order.delivery.coupon.status';

/**
 * 정산 표시금액에서 취소된 발송건을 제외하는 계약 (197-16).
 *
 * 배경: 균일요율 분기가 mapping.amount(주문 수량)를 곱해, 부분취소로 환불된 건까지 남았다.
 * 실제 정산확정 금액(getOrderSettlementSummary)은 완료건만 더하므로 돈은 정확했지만,
 * 같은 함수를 쓰는 거래명세서·발송완료리포트가 환불된 건까지 청구했다.
 *
 * ★ 차감 기준이 "주문 수량 − 취소 건수" 인 것이 핵심이다.
 *   살아있는 발송건 수(deliveries.length)로 세면 안 된다 — 그 목록은 "폐기 후 재발행으로
 *   대체된 원본"(D3-52)도 빼는데, 그 경우 재발행분이 자리를 채우므로 청구 수량은 유지돼야 한다.
 *   취소만 순수 감소다.
 */
describe('buildSettlementDisplayLines — 취소 발송건 제외', () => {
  const delivery = (over: Partial<Record<string, unknown>> = {}) =>
    ({
      id: 1,
      status: IOrderDeliveryStatus.COMPLETE,
      couponStatus: OrderDeliveryCouponStatus.NOT_USED,
      replacedFromId: null,
      settleFee: null,
      settlePriceAdjustment: null,
      ...over,
    }) as any;

  // 실제 데이터에서 mapping.amount(주문 수량)와 발송건 행 수는 일치한다.
  // 균일 분기가 "주문 수량 − 취소 건수" 로 계산하므로 fixture 도 그 관계를 지켜야 한다.
  const mapping = (over: Partial<Record<string, unknown>> = {}) =>
    ({
      amount: 5,
      fee: null,
      priceAdjustment: null,
      product: { price: 10000 },
      snapshotProductPrice: 10000,
      ...over,
    }) as any;

  describe('균일 요율', () => {
    it('취소된 발송건을 금액에서 뺀다', () => {
      const m = mapping({
        orderDeliveries: [
          delivery({ id: 1 }),
          delivery({ id: 2 }),
          delivery({ id: 3, status: IOrderDeliveryStatus.CANCEL }),
          delivery({ id: 4, status: IOrderDeliveryStatus.CANCEL }),
          delivery({ id: 5, status: IOrderDeliveryStatus.CANCEL }),
        ],
      });

      // 5건 중 3건 취소 → 살아있는 2건만 청구
      expect(buildSettlementDisplayLines(m)).toEqual([{ price: 10000, amount: 2 }]);
      expect(calculateMappingSettlementBaseAmount(m)).toBe(20000);
    });

    it('취소가 없으면 종전과 같다', () => {
      const m = mapping({
        orderDeliveries: [delivery({ id: 1 }), delivery({ id: 2 }), delivery({ id: 3 })],
        amount: 3,
      });

      expect(calculateMappingSettlementBaseAmount(m)).toBe(30000);
    });

    it('전건이 취소되면 0 원이다', () => {
      const m = mapping({
        amount: 2,
        orderDeliveries: [
          delivery({ id: 1, status: IOrderDeliveryStatus.CANCEL }),
          delivery({ id: 2, status: IOrderDeliveryStatus.CANCEL }),
        ],
      });

      // 주문 수량 2 − 취소 2 = 0
      expect(calculateMappingSettlementBaseAmount(m)).toBe(0);
    });

    // 대기(WAIT)·실패(FAIL)는 취소가 아니다. 실패건의 정산 반영 정책은 이번 변경 범위가 아니므로
    // 종전 동작(포함)을 유지한다.
    it.each([
      ['대기', IOrderDeliveryStatus.WAIT],
      ['실패', IOrderDeliveryStatus.FAIL],
      ['SMS 완료', IOrderDeliveryStatus.COMPLETE_SMS],
    ])('%s 상태는 빼지 않는다', (_caseName, status) => {
      const m = mapping({ amount: 2, orderDeliveries: [delivery({ id: 1 }), delivery({ id: 2, status })] });

      expect(calculateMappingSettlementBaseAmount(m)).toBe(20000);
    });
  });

  // 발송건 목록이 비어 있으면 취소 수가 0 이라 mapping.amount 가 그대로 나온다.
  // 관계 미로드(undefined)와 실제 0건([])을 구분하지 않는 기존 계약이 유지된다
  // (settle.service.rate-split-d3-49.spec "orderDeliveries 가 비어 있으면 균일 분기").
  describe('발송건 목록이 비어 있을 때', () => {
    it.each([
      ['미로드(undefined)', undefined],
      ['빈 배열([])', []],
    ])('%s 이면 주문 수량을 그대로 쓴다', (_caseName, orderDeliveries) => {
      const m = mapping({ orderDeliveries, amount: 5 });

      expect(buildSettlementDisplayLines(m)).toEqual([{ price: 10000, amount: 5 }]);
      expect(calculateMappingSettlementBaseAmount(m)).toBe(50000);
    });
  });

  describe('기존 필터와의 공존', () => {
    // D3-52: 재발행 원본은 금액 계산에서 빠지지만, 재발행분이 자리를 채우므로
    // 균일 분기의 청구 수량(mapping.amount)은 줄지 않는다 — 기존 계약 그대로다.
    it('재발행으로 대체된 원본이 있어도 청구 수량은 주문 수량을 유지한다', () => {
      const m = mapping({
        amount: 2,
        orderDeliveries: [
          delivery({ id: 1, couponStatus: OrderDeliveryCouponStatus.CANCEL }), // 대체된 원본
          delivery({ id: 2, replacedFromId: 1 }), // 재발행 신규
        ],
      });

      expect(calculateMappingSettlementBaseAmount(m)).toBe(20000);
    });

    // 재발행 원본은 재발행분이 자리를 채우므로 수량을 줄이지 않는다.
    // 취소만 순수 감소다 — 두 사유가 한 행에 겹쳐도 취소로 한 번만 차감된다.
    it('재발행 원본이면서 취소인 행은 취소로 한 번만 차감된다', () => {
      const m = mapping({
        amount: 3,
        orderDeliveries: [
          delivery({ id: 1, status: IOrderDeliveryStatus.CANCEL, couponStatus: OrderDeliveryCouponStatus.CANCEL }),
          delivery({ id: 2, replacedFromId: 1 }),
          delivery({ id: 3 }),
        ],
      });

      // 주문 수량 3 − 취소 1 = 2
      expect(calculateMappingSettlementBaseAmount(m)).toBe(20000);
    });
  });

  describe('차등 요율 (SSG 중복할인 등)', () => {
    // 차등 분기는 종전에도 발송건을 순회했으므로 CANCEL 이 자동으로 빠진다.
    it('취소건이 요율별 집계에서 빠진다', () => {
      const m = mapping({
        amount: 3,
        fee: 10,
        priceAdjustment: 'DISCOUNT',
        orderDeliveries: [
          delivery({ id: 1, settleFee: 10, settlePriceAdjustment: 'DISCOUNT' }),
          delivery({ id: 2, settleFee: 10, settlePriceAdjustment: 'DISCOUNT' }),
          delivery({ id: 3, settleFee: 10, settlePriceAdjustment: 'DISCOUNT', status: IOrderDeliveryStatus.CANCEL }),
        ],
      });

      const lines = buildSettlementDisplayLines(m);

      expect(lines).toHaveLength(1);
      expect(lines[0].amount).toBe(2);
    });
  });
});
