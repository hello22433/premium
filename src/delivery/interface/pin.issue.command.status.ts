/**
 * 협력사 PIN 발급 명령 상태 (§5.2).
 *
 * `RETRY_PENDING`·`RECONCILING`·`RETRYING`·`UNKNOWN_DEFERRED` 는 미확정 상태이며
 * 완료·정산·최종 환불을 차단한다(§9 재무·정산 계약).
 */
export enum PinIssueCommandStatus {
  /** 발급 명령 확정 저장 후 협력사 호출 진행 */
  STARTED = 'STARTED',
  /** 재조회로 NOT_ISSUED 가 증명되어 재시도 예약 */
  RETRY_PENDING = 'RETRY_PENDING',
  /** 협력사 결과 조회로 ISSUED/NOT_ISSUED 재조정 중 */
  RECONCILING = 'RECONCILING',
  /** 재시도 실행 중(배타 슬롯 보유) */
  RETRYING = 'RETRYING',
  SUCCEEDED = 'SUCCEEDED',
  /** 재시도 무의미한 확정 실패 */
  TERMINAL = 'TERMINAL',
  /** 재시도 소진 */
  EXHAUSTED = 'EXHAUSTED',
  /** 발급 여부 불명 — 신규 발급 기본 금지(§8.1 B) */
  UNKNOWN_DEFERRED = 'UNKNOWN_DEFERRED',
}

/**
 * `RETRY`(PIN 변형) 슬롯 점유를 막는 진행·재조정 상태 (§6.1 RETRY 가드).
 */
export const PIN_RETRY_BLOCKING_STATUSES: PinIssueCommandStatus[] = [
  PinIssueCommandStatus.STARTED,
  PinIssueCommandStatus.RECONCILING,
  PinIssueCommandStatus.RETRYING,
  PinIssueCommandStatus.UNKNOWN_DEFERRED,
];

/**
 * 협력사 원본 응답코드(`PARTNER_RESPONSE_*`)의 분류 버킷 (§9 분류표).
 *
 * - SUCCESS   : 발급 완료(ISSUED)
 * - DUPLICATE : 같은 요청 키 재사용으로 이미 발급 → 결과조회로 기존 PIN 복구. 재발급 아님
 * - RETRYABLE : 재조회로 NOT_ISSUED 증명이 가능한 일시 오류 → 조회 먼저, NOT_ISSUED 일 때만 1회 재발급
 * - TERMINAL  : 잔액·한도·상품중단·파라미터·번호오류 등 재시도 무의미
 * - UNKNOWN   : 발급 성공 여부 불명확 → 재조회, 불가 시 운영 확인. 신규 발급 기본 금지
 */
export enum PartnerResponseClass {
  SUCCESS = 'SUCCESS',
  DUPLICATE = 'DUPLICATE',
  RETRYABLE = 'RETRYABLE',
  TERMINAL = 'TERMINAL',
  UNKNOWN = 'UNKNOWN',
}
