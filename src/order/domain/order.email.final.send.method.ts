/**
 * 이메일 쿠폰의 '최종 발신 수단'.
 * 고객이 이메일 링크에서 전화번호를 입력했을 때 실제 모바일 쿠폰을 보내는 채널.
 *
 * - NULL  = 레거시 = ALIM_TALK 과 동일 동작 (알림톡 → MMS 폴백)
 * - ALIM_TALK = 알림톡 우선, 실패 시 MMS 폴백
 * - MMS   = MMS 직행, 폴백 없음 (P-a 비대칭 정책)
 */
export enum OrderEmailFinalSendMethod {
  ALIM_TALK = 'ALIM_TALK',
  MMS = 'MMS',
}
