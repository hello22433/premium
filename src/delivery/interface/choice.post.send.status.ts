/**
 * 초이스 쿠폰 선택 후 "별도 쿠폰 이미지 발송"의 명시적 상태.
 *
 * 선택 완료(choiceSelectProductId)와 쿠폰 이미지 발송 성공은 동일하지 않다.
 * 기존에는 선택 후 SMS 실패 시 로그만 남겨 발송 성공 여부를 판단할 수 없었다.
 * 재진입 차단(blockChoiceReentry)은 이 상태를 기준으로 한다.
 */
export enum ChoicePostSendStatus {
  /** EMAIL 또는 ALIM_TALK+COMPLETE 등 별도 발송이 필요 없는 경우 */
  NOT_REQUIRED = 'NOT_REQUIRED',
  /** 한 요청이 별도 발송을 처리 중 (claim 보유) */
  SENDING = 'SENDING',
  /** 별도 쿠폰 이미지 발송 성공 (terminal — FAILED 로 되돌리지 않음) */
  SENT = 'SENT',
  /** 별도 발송 실패 — 재시도 허용 */
  FAILED = 'FAILED',
}
