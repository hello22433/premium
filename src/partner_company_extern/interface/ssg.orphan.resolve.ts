/**
 * SSG orphan resolver 결과.
 * plans/ssg-balance-refactor.md PR2.
 *
 * ATTEMPTED state 인 orderDelivery에 대해 SSG check API로 실제 등록 여부를 확정한 후의 결과.
 * caller (PR3 refund resolver, 재발송 가드 등) 는 이 결과로 SSG 행사 잔액 분기를 결정한다.
 *
 * - CONFIRMED              : 등록된 PIN 발견 + markConfirmed 성공 → 행사 잔액 복구 X
 * - FAILED                 : 모든 후보 정상 NotFound + markFailed 성공 → 행사 잔액 복구 O
 * - NETWORK_UNKNOWN        : check 호출 도중 네트워크/파싱 오류 발생 → ATTEMPTED 유지, 재시도 필요. 행사 잔액 손대지 않음 (안전 측)
 * - SKIPPED_NOT_ATTEMPTED  : 입력 state 가 ATTEMPTED 아님 (NONE/CONFIRMED/FAILED). 현재 state 값을 별도로 조회해 분기
 * - SKIPPED_NO_CANDIDATES  : ssg_issue_log 에 eventSeq 가 채워진 후보가 없음 (legacy row 등) → 운영 보정 필요
 */
export enum SsgOrphanResolveOutcome {
  CONFIRMED = 'CONFIRMED',
  FAILED = 'FAILED',
  NETWORK_UNKNOWN = 'NETWORK_UNKNOWN',
  SKIPPED_NOT_ATTEMPTED = 'SKIPPED_NOT_ATTEMPTED',
  SKIPPED_NO_CANDIDATES = 'SKIPPED_NO_CANDIDATES',
}
