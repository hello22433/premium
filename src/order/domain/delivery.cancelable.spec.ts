import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { IOrderType } from '../interface/order.type';
import {
  DELIVERY_CANCEL_CUTOFF_MS,
  DeliveryCancelBlockReason,
  DeliveryCancelableView,
  evaluateDeliveryCancelable,
} from './delivery.cancelable';

/**
 * evaluateDeliveryCancelable 은 findCancelableDeliveryIds(order.service.ts)의 SQL 조건집합을
 * 화면용으로 미러링한다. 여기서는 "모든 조건을 만족한 기준행" 에서 각 조건을 하나씩 깨뜨려
 * 정확히 그 사유로 cancelable=false 가 되는지 못 박는다(양쪽 drift 감지).
 */
describe('evaluateDeliveryCancelable', () => {
  const now = new Date('2026-07-29T00:00:00.000Z');
  // 컷오프(10분) 이후로 넉넉히 예약된 발송건 = 취소 가능 기준행
  const okSendRequestAt = new Date(now.getTime() + DELIVERY_CANCEL_CUTOFF_MS + 60 * 1000);

  const base: DeliveryCancelableView = {
    status: IOrderDeliveryStatus.WAIT,
    actualSendAt: null,
    claimedAt: null,
    couponIssuedAt: null,
    barCode: null,
    reportState: null,
    sendRequestAt: okSendRequestAt,
  };

  it('모든 조건을 만족하면 취소 가능(blockReason=null)', () => {
    expect(evaluateDeliveryCancelable(base, IOrderType.GENERAL, now)).toEqual({
      cancelable: true,
      blockReason: null,
    });
  });

  it('1) status != WAIT → NOT_WAITING', () => {
    for (const status of [
      IOrderDeliveryStatus.COMPLETE,
      IOrderDeliveryStatus.FAIL,
      IOrderDeliveryStatus.CANCEL,
      IOrderDeliveryStatus.TEMP,
    ]) {
      expect(evaluateDeliveryCancelable({ ...base, status }, IOrderType.GENERAL, now)).toEqual({
        cancelable: false,
        blockReason: DeliveryCancelBlockReason.NOT_WAITING,
      });
    }
  });

  it('2) actualSendAt 세팅(외부API 성공은 WAIT 로 남음) → ALREADY_SENT', () => {
    expect(
      evaluateDeliveryCancelable({ ...base, actualSendAt: now }, IOrderType.GENERAL, now).blockReason,
    ).toBe(DeliveryCancelBlockReason.ALREADY_SENT);
  });

  it('5) couponIssuedAt 또는 barCode 있으면 → ALREADY_ISSUED', () => {
    expect(
      evaluateDeliveryCancelable({ ...base, couponIssuedAt: now }, IOrderType.GENERAL, now).blockReason,
    ).toBe(DeliveryCancelBlockReason.ALREADY_ISSUED);
    expect(
      evaluateDeliveryCancelable({ ...base, barCode: 'ABC123' }, IOrderType.GENERAL, now).blockReason,
    ).toBe(DeliveryCancelBlockReason.ALREADY_ISSUED);
  });

  it('3)/4) claimedAt 또는 reportState 있으면 → IN_PROGRESS', () => {
    expect(
      evaluateDeliveryCancelable({ ...base, claimedAt: now }, IOrderType.GENERAL, now).blockReason,
    ).toBe(DeliveryCancelBlockReason.IN_PROGRESS);
    expect(
      evaluateDeliveryCancelable({ ...base, reportState: 'SOME_STATE' }, IOrderType.GENERAL, now).blockReason,
    ).toBe(DeliveryCancelBlockReason.IN_PROGRESS);
  });

  it('6) EXTERNAL 주문 → EXTERNAL_ORDER', () => {
    expect(evaluateDeliveryCancelable(base, IOrderType.EXTERNAL, now).blockReason).toBe(
      DeliveryCancelBlockReason.EXTERNAL_ORDER,
    );
  });

  it('7) 컷오프 미만(발송 임박) → CUTOFF_PASSED', () => {
    const tooLate = new Date(now.getTime() + DELIVERY_CANCEL_CUTOFF_MS - 1000);
    expect(
      evaluateDeliveryCancelable({ ...base, sendRequestAt: tooLate }, IOrderType.GENERAL, now).blockReason,
    ).toBe(DeliveryCancelBlockReason.CUTOFF_PASSED);
  });

  it('7) 정확히 컷오프 경계(now+cutoff)는 취소 가능(SQL 의 >= 와 일치)', () => {
    const exactly = new Date(now.getTime() + DELIVERY_CANCEL_CUTOFF_MS);
    expect(evaluateDeliveryCancelable({ ...base, sendRequestAt: exactly }, IOrderType.GENERAL, now).cancelable).toBe(
      true,
    );
  });

  it('sendRequestAt=null(예약 아님)은 취소 대상 아님 → CUTOFF_PASSED', () => {
    expect(
      evaluateDeliveryCancelable({ ...base, sendRequestAt: null }, IOrderType.GENERAL, now).blockReason,
    ).toBe(DeliveryCancelBlockReason.CUTOFF_PASSED);
  });

  it('판정 우선순위: 이미 발송 > 컷오프 (둘 다 위반 시 ALREADY_SENT)', () => {
    const tooLate = new Date(now.getTime() - 1000);
    expect(
      evaluateDeliveryCancelable(
        { ...base, actualSendAt: now, sendRequestAt: tooLate },
        IOrderType.GENERAL,
        now,
      ).blockReason,
    ).toBe(DeliveryCancelBlockReason.ALREADY_SENT);
  });
});
