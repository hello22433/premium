/**
 * 환불 외부 부작용 상태 (§5.4 — 4번째 상태 머신).
 *
 * PG/지갑/legacy 환불의 외부 부작용은 workflow·PIN·message 상태에 섞지 않는다.
 * 한 `order_delivery` 에 미확정 attempt 는 최대 1개(단일 in-flight)로 강제해 중복 환불을 막는다.
 *
 * `FAILED`(외부 미실행 확정) 이후에만 신규 attempt 를 열 수 있고,
 * `UNKNOWN`(실행 여부 불명) 이후에는 어떤 경우에도 신규 attempt 를 열지 않는다.
 */
export enum RefundAttemptStatus {
  CLAIMED = 'CLAIMED',
  SUBMITTING = 'SUBMITTING',
  RECONCILING = 'RECONCILING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  UNKNOWN = 'UNKNOWN',
}

/** 미확정(단일 in-flight 제약 대상) 환불 상태 */
export const REFUND_IN_FLIGHT_STATUSES: RefundAttemptStatus[] = [
  RefundAttemptStatus.CLAIMED,
  RefundAttemptStatus.SUBMITTING,
  RefundAttemptStatus.RECONCILING,
  RefundAttemptStatus.UNKNOWN,
];

/**
 * 환불 진입 경로 (§5.4).
 *
 * - A : `OPS_REVIEW_REQUIRED` 경유(DUAL 필수). 성공 시 WF `RESOLVED_MANUALLY_REFUNDED` 원자 전이 +
 *       `settled_refund_attempt_id` 기록. 실패·불명이면 `OPS_REVIEW_REQUIRED` **잔류**.
 * - B : 종결 상태(`FAILED_FINAL`/`CANCELLED`/`RESOLVED_MANUALLY_FAILED`) 환불(DUAL 불요·슬롯 fencing만).
 *       성공 시 종결 상태 유지 + `refundedAt` 표식. 실패·불명이면 `OPS_REVIEW_REQUIRED` **승격**.
 */
export enum RefundEntryPath {
  A = 'A',
  B = 'B',
}

/** 환불 범위(승인 payload 와 대조 대상, §10 불변식 ①) */
export enum RefundScope {
  FULL = 'FULL',
  PARTIAL = 'PARTIAL',
}
