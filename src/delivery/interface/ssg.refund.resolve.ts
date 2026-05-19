/**
 * SSG 행사 잔액 복구 분기 결과.
 * plans/ssg-balance-refactor.md PR3.
 *
 * delivery batch refund 흐름 (refundForFail / 재발송 선차감 환불 / issue() throw catch) 과
 * external_api refund 흐름 모두 동일 resolver 를 호출한다. caller 는 outcome 으로 로깅/알림만 분기.
 *
 * - RESTORED          : SSG 행사 잔액 복구 호출 발생 (state NONE/FAILED 또는 orphan FAILED 확정)
 * - SKIPPED_CONFIRMED : state CONFIRMED → 행사 잔액 손대지 않음 (gross 모델 정합)
 * - DEFERRED          : orphan resolver 가 NETWORK_UNKNOWN / SKIPPED_* 반환. ATTEMPTED 유지.
 *                       잔액은 건드리지 않으며 운영 알림 대상.
 */
export enum SsgRefundOutcome {
  RESTORED = 'RESTORED',
  SKIPPED_CONFIRMED = 'SKIPPED_CONFIRMED',
  DEFERRED = 'DEFERRED',
}
