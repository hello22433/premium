/**
 * SSG INSERT durable state.
 * plans/ssg-balance-refactor.md PR1.
 *
 * 신세계 행사 한도는 gross 모델(발급 시도 누계)이므로, INSERT 시도 사실 자체가
 * 영구 신호여야 한다. barCode/refundedAt이 다른 흐름에서 NULL로 덮어쓰일 수 있어
 * 그것들로는 신뢰 가능한 판정이 불가능하다.
 *
 * monotonic transition:
 *   NONE → ATTEMPTED → (CONFIRMED | FAILED)
 * CONFIRMED/FAILED는 terminal. 역행/교차 전이 금지.
 */
export enum SsgInsertState {
  NONE = 'NONE',
  ATTEMPTED = 'ATTEMPTED',
  CONFIRMED = 'CONFIRMED',
  FAILED = 'FAILED',
}
