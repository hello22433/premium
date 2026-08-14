import { calculateMappingBilledQuantity, calculateMappingSettlementBaseAmount } from './settle-fee.util';
import { IOrderDeliveryStatus } from '../delivery/interface/order.delivery.status';
import { OrderDeliveryCouponStatus } from '../delivery/interface/order.delivery.coupon.status';

/**
 * 청구 수량과 정산금액이 **같은 분해**에서 나오는지 고정한다 (197-16).
 *
 * 이 브랜치가 정산금액(buildSettlementDisplayLines)에서 취소 발송건을 빼면서,
 * 수량을 `mapping.amount`(원 주문 수량)로 그대로 읽던 소비자들과 기준이 갈라졌다.
 * 실제로 고객사별정산 목록에서는 **같은 루프의 인접한 두 줄**이 다른 기준을 써서
 * 한 행에 "수량 10건 / 금액 8건분" 이 나왔다.
 *
 * 여기서 지키는 계약: 취소분을 뺀 수량 × 단가 == 정산금액. 둘 중 하나만 기준이 바뀌면 깨진다.
 */
describe('calculateMappingBilledQuantity — 청구 수량', () => {
  const delivery = (id: number, status: IOrderDeliveryStatus, over: Record<string, unknown> = {}) =>
    ({
      id,
      status,
      settleFee: null,
      settlePriceAdjustment: null,
      couponStatus: OrderDeliveryCouponStatus.NOT_USED,
      replacedFromId: null,
      ...over,
    }) as never;

  const uniformMapping = (amount: number, deliveries: unknown[]) =>
    ({
      amount,
      fee: null,
      priceAdjustment: null,
      product: { price: 5000 },
      orderDeliveries: deliveries,
    }) as never;

  it('취소된 발송건 수를 뺀 수량을 돌려준다', () => {
    const mapping = uniformMapping(5, [
      delivery(1, IOrderDeliveryStatus.COMPLETE),
      delivery(2, IOrderDeliveryStatus.COMPLETE),
      delivery(3, IOrderDeliveryStatus.CANCEL),
      delivery(4, IOrderDeliveryStatus.CANCEL),
      delivery(5, IOrderDeliveryStatus.WAIT),
    ]);

    expect(calculateMappingBilledQuantity(mapping)).toBe(3);
  });

  it('취소가 없으면 주문 수량과 같다', () => {
    const mapping = uniformMapping(3, [
      delivery(1, IOrderDeliveryStatus.COMPLETE),
      delivery(2, IOrderDeliveryStatus.WAIT),
      delivery(3, IOrderDeliveryStatus.WAIT),
    ]);

    expect(calculateMappingBilledQuantity(mapping)).toBe(3);
  });

  // ★ 이 파일의 핵심. 수량과 금액이 서로 다른 기준을 쓰면 여기서 깨진다.
  it('수량 × 단가 == 정산금액 (두 값이 같은 분해에서 나온다)', () => {
    const mapping = uniformMapping(5, [
      delivery(1, IOrderDeliveryStatus.COMPLETE),
      delivery(2, IOrderDeliveryStatus.COMPLETE),
      delivery(3, IOrderDeliveryStatus.CANCEL),
      delivery(4, IOrderDeliveryStatus.CANCEL),
      delivery(5, IOrderDeliveryStatus.WAIT),
    ]);

    expect(calculateMappingBilledQuantity(mapping) * 5000).toBe(calculateMappingSettlementBaseAmount(mapping));
  });

  // 폐기 후 재발행으로 대체된 CANCEL 원본은 재발행분이 자리를 채우므로 청구 수량이 줄지 않는다.
  // (정산금액 쪽과 동일한 근거 — 여기서 빼면 재발행 건의 수량·금액이 절반이 된다.)
  it('재발행으로 대체된 CANCEL 원본은 수량에서 빼지 않는다', () => {
    const mapping = uniformMapping(2, [
      // 원본: 폐기(couponStatus=CANCEL) 되고 아래 재발행 건이 대체
      delivery(1, IOrderDeliveryStatus.COMPLETE, { couponStatus: OrderDeliveryCouponStatus.CANCEL }),
      delivery(2, IOrderDeliveryStatus.COMPLETE, { replacedFromId: 1 }),
    ]);

    expect(calculateMappingBilledQuantity(mapping)).toBe(2);
  });
});
