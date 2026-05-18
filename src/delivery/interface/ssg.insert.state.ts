/**
 * SSG INSERT durable state.
 * plans/ssg-balance-refactor.md PR1.
 *
 * 신세계 행사 한도는 gross 모델(발급 시도 누계)이므로, INSERT 시도 사실 자체가
 * 영구 신호여야 한다. barCode/refundedAt이 다른 흐름에서 NULL로 덮어쓰일 수 있어
 * 그것들로는 신뢰 가능한 판정이 불가능하다.
 *
 * state machine (Lazy):
 *   (row 없음 = NONE) → ATTEMPTED → (CONFIRMED | FAILED)
 *   FAILED → ATTEMPTED 재시도 허용 (재발송 새 PIN 발급)
 *
 * CONFIRMED 만 진짜 terminal. FAILED는 정책상 재발송 새 PIN 발급 허용이라 retryable.
 * gross 한도 누계는 state 컬럼이 아닌 ssg_issue_log row 누적으로 산출되므로,
 * FAILED → ATTEMPTED 재시도 시 시도 횟수가 손실되지 않는다.
 */
export enum SsgInsertState {
  NONE = 'NONE',
  ATTEMPTED = 'ATTEMPTED',
  CONFIRMED = 'CONFIRMED',
  FAILED = 'FAILED',
}
