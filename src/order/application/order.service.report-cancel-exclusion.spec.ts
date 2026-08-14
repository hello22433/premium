import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { isDeliveryInCompleteReport } from './order.service';

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
 * ★ 여기서는 스펙 로컬 복사본이 아니라 프로덕션의 실제 술어(isDeliveryInCompleteReport)를 import 해
 *   검증한다. getDeliveryCompleteReport / getDeliveryCompleteReportMultiple 두 리포트 루프가
 *   `.filter(isDeliveryInCompleteReport)` 로 이 함수를 쓰므로, 술어를 바꾸면 여기서 깨진다.
 *   (리포트 본문은 복호화·마스킹·PDF 등 외부 의존이 많아 전체를 태우는 대신 술어를 고정한다.)
 */
describe('발송완료리포트 — 취소 발송건 제외 술어 (isDeliveryInCompleteReport)', () => {
  it('취소된 발송건은 리포트 행에서 빠진다', () => {
    expect(isDeliveryInCompleteReport({ status: IOrderDeliveryStatus.CANCEL })).toBe(false);
  });

  it.each([
    ['발송완료', IOrderDeliveryStatus.COMPLETE],
    ['SMS 발송완료', IOrderDeliveryStatus.COMPLETE_SMS],
    ['발송실패', IOrderDeliveryStatus.FAIL],
    ['SMS 발송실패', IOrderDeliveryStatus.FAIL_SMS],
    ['발송대기', IOrderDeliveryStatus.WAIT],
    ['임시저장', IOrderDeliveryStatus.TEMP],
  ])('%s 은 리포트에 남는다', (_caseName, status) => {
    expect(isDeliveryInCompleteReport({ status })).toBe(true);
  });

  it('5건 중 3건 취소면 2행만 남는다', () => {
    const deliveries = [
      { status: IOrderDeliveryStatus.COMPLETE },
      { status: IOrderDeliveryStatus.COMPLETE },
      { status: IOrderDeliveryStatus.CANCEL },
      { status: IOrderDeliveryStatus.CANCEL },
      { status: IOrderDeliveryStatus.CANCEL },
    ];

    expect(deliveries.filter(isDeliveryInCompleteReport)).toHaveLength(2);
  });
});
