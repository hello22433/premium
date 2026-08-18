import { countMobileReportDeliveries } from './settle.service';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';

/**
 * 모바일 정산/수익 리포트 발송건 집계 (197-16 부분취소 반영).
 *
 * 핵심 사실: 발송취소는 status 만 CANCEL 로 바꾸고 couponStatus 는 건드리지 않는다.
 * coupon_status 컬럼은 NOT NULL DEFAULT NOT_USED 라(로컬 DB 확인), 발송취소 건은
 * status=CANCEL / couponStatus=NOT_USED 로 남는다.
 *
 * 따라서 이 집계는 두 가지를 동시에 지켜야 한다:
 *  (1) 발송취소 환불이 리포트에 보여야 한다 — couponStatus 만 보면 환불 0 으로 사라진다.
 *  (2) 발송취소 건이 미교환(NOT_USED)으로 이중 카운트되면 안 된다 — couponStatus 가
 *      NOT_USED 라, 환불을 먼저 걸러내지 않으면 미교환에도 잡혀 profitAmount 를 부풀린다.
 */
type D = { status: IOrderDeliveryStatus; couponStatus: OrderDeliveryCouponStatus };
const d = (status: IOrderDeliveryStatus, couponStatus: OrderDeliveryCouponStatus): D => ({
  status,
  couponStatus,
});

describe('countMobileReportDeliveries', () => {
  it('교환(USED)/미교환(NOT_USED)은 couponStatus 로 센다', () => {
    const counts = countMobileReportDeliveries([
      d(IOrderDeliveryStatus.COMPLETE, OrderDeliveryCouponStatus.USED),
      d(IOrderDeliveryStatus.COMPLETE, OrderDeliveryCouponStatus.NOT_USED),
      d(IOrderDeliveryStatus.COMPLETE, OrderDeliveryCouponStatus.NOT_USED),
    ]);

    expect(counts.tradeAmount).toBe(1);
    expect(counts.unExchangedAmount).toBe(2);
    expect(counts.refundAmount).toBe(0);
  });

  it('폐기(couponStatus=CANCEL)를 환불로 센다 — 기존 동작', () => {
    const counts = countMobileReportDeliveries([d(IOrderDeliveryStatus.COMPLETE, OrderDeliveryCouponStatus.CANCEL)]);

    expect(counts.discardAmount).toBe(1);
    expect(counts.refundAmount).toBe(1);
    expect(counts.unExchangedAmount).toBe(0);
  });

  // ★ 이번 수정의 핵심. 발송취소 건은 status=CANCEL / couponStatus=NOT_USED 다.
  it('발송취소(status=CANCEL, couponStatus=NOT_USED)를 환불로 세고 미교환으로는 세지 않는다', () => {
    const counts = countMobileReportDeliveries([d(IOrderDeliveryStatus.CANCEL, OrderDeliveryCouponStatus.NOT_USED)]);

    expect(counts.discardAmount).toBe(1);
    expect(counts.refundAmount).toBe(1);
    // ★ NOT_USED 이지만 취소됐으므로 미교환이 아니다 — 이중 카운트 방지.
    expect(counts.unExchangedAmount).toBe(0);
  });

  it('폐기·발송취소·정상건이 섞여도 각 버킷이 상호배타적으로 잡힌다', () => {
    const counts = countMobileReportDeliveries([
      d(IOrderDeliveryStatus.COMPLETE, OrderDeliveryCouponStatus.USED), // 교환
      d(IOrderDeliveryStatus.COMPLETE, OrderDeliveryCouponStatus.NOT_USED), // 미교환
      d(IOrderDeliveryStatus.COMPLETE, OrderDeliveryCouponStatus.CANCEL), // 폐기
      d(IOrderDeliveryStatus.CANCEL, OrderDeliveryCouponStatus.NOT_USED), // 발송취소
    ]);

    expect(counts.tradeAmount).toBe(1);
    expect(counts.unExchangedAmount).toBe(1); // 발송취소 건은 여기 안 들어간다
    expect(counts.discardAmount).toBe(2); // 폐기 + 발송취소
    expect(counts.refundAmount).toBe(2);
  });

  // 외부API취소는 status=CANCEL + couponStatus=CANCEL 을 함께 갖는다. 이 리포트 모집단에는
  // 안 들어오지만(order.status=DELIVERY_CANCEL 로 필터), 방어적으로 한 번만 세는지 고정한다.
  it('두 축이 함께 CANCEL 이어도 환불은 한 번만 센다', () => {
    const counts = countMobileReportDeliveries([d(IOrderDeliveryStatus.CANCEL, OrderDeliveryCouponStatus.CANCEL)]);

    expect(counts.refundAmount).toBe(1);
    expect(counts.discardAmount).toBe(1);
  });
});
