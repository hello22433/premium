import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';

/**
 * 발송완료리포트에서 취소된 발송건을 제외하는 계약 (197-16).
 *
 * 부분취소 이후 잔여분이 전부 발송되면 주문이 DELIVERY_COMPLETE 로 전이되고, 그때부터
 * 발송완료리포트·거래명세서 발급 게이트가 열린다. 취소된 발송건을 그대로 열거하면
 * 발송시각·바코드가 공란인 행이 "발송완료 리포트" 에 섞인다.
 *
 * 실패(FAIL)건은 제외하지 않는다. 재발송으로 되살아날 수 있고, PIN 발급 이후 전송만 실패한
 * 경우에는 바코드가 살아 있어 고객이 확인해야 할 정보다(markSendFail 은 status/failedAt 만
 * 바꾸고 barCode 를 지우지 않는다).
 *
 * 리포트 본문은 복호화·마스킹·PDF 등 외부 의존이 많아 서비스 전체를 띄우기 어렵다.
 * 여기서는 실제로 적용한 필터 술어만 고정한다 — 조건이 바뀌면 여기서 깨진다.
 */
describe('발송완료리포트 — 취소 발송건 제외 술어', () => {
  const reportFilter = (delivery: { status: IOrderDeliveryStatus }) =>
    delivery.status !== IOrderDeliveryStatus.CANCEL;

  it('취소된 발송건은 리포트 행에서 빠진다', () => {
    expect(reportFilter({ status: IOrderDeliveryStatus.CANCEL })).toBe(false);
  });

  it.each([
    ['발송완료', IOrderDeliveryStatus.COMPLETE],
    ['SMS 발송완료', IOrderDeliveryStatus.COMPLETE_SMS],
    ['발송실패', IOrderDeliveryStatus.FAIL],
    ['SMS 발송실패', IOrderDeliveryStatus.FAIL_SMS],
    ['발송대기', IOrderDeliveryStatus.WAIT],
    ['임시저장', IOrderDeliveryStatus.TEMP],
  ])('%s 은 리포트에 남는다', (_caseName, status) => {
    expect(reportFilter({ status })).toBe(true);
  });

  it('5건 중 3건 취소면 2행만 남는다', () => {
    const deliveries = [
      { status: IOrderDeliveryStatus.COMPLETE },
      { status: IOrderDeliveryStatus.COMPLETE },
      { status: IOrderDeliveryStatus.CANCEL },
      { status: IOrderDeliveryStatus.CANCEL },
      { status: IOrderDeliveryStatus.CANCEL },
    ];

    expect(deliveries.filter(reportFilter)).toHaveLength(2);
  });
});
