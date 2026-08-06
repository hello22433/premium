/**
 * 이번 배치 pass 에서 판정이 불가능해 **뒤로 미룬** 발송건 시그널
 * (`plans/2026-08-03-pin-issue-retry-wiring.md` §4.1 2-pass).
 *
 * 실패가 아니다. `order_delivery.status` 를 `FAIL` 로 확정하지 않고, 환불도 이력도 남기지 않으며,
 * `claimed_at` 을 유지한 채 같은 배치 사이클의 pass 2 에서 재처리 대상이 된다.
 *
 * 계약(`plans/프리미엄_발송실패_재발송_구상.md`) §2 조항 2 — "`RETRYABLE` PIN 실패만 최초 발송을
 * 처리한 `issueAndSend` 배치의 **본 처리 종료 직후** 1회 자동 재시도한다. 30~60분 고정 대기는
 * 사용하지 않는다."
 *
 * ⚠ 이 에러는 "발급되지 않았다" 를 뜻하지 **않는다**. 조회가 실패해 등록 여부를 **알 수 없다**는
 * 뜻이다. 따라서 pass 2 는 `issue()` 를 진입점부터 다시 실행해 후보 조회(`ssg_issue_log` → cust_info)
 * 를 포함한 판정 절차를 처음부터 밟아야 하며, pass 1 의 중간 판정을 캐시해 건너뛰면 안 된다
 * (그 사이 SSG 에 반영된 이전 INSERT 를 놓쳐 중복 PIN 이 나간다).
 */
export class DeferredDeliveryError extends Error {
  constructor(
    public readonly orderDeliveryId: number,
    public readonly cause: unknown,
  ) {
    super(`발송 보류(다음 pass 재시도): orderDeliveryId=${orderDeliveryId}`);
    this.name = 'DeferredDeliveryError';
  }
}
