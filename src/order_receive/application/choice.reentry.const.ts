/**
 * post-selection 별도 발송 / EMAIL 쿠폰 발송의 SENDING claim 이 stale 로 간주되어
 * 다른 요청이 재선점할 수 있게 되기까지의 timeout.
 *
 * claim 쿼리, blockChoiceReentry 판정, 테스트가 모두 같은 값을 사용해야 한다.
 * 외부 발송(알림톡/MMS/PIN 발급) 1회 처리 시간을 충분히 덮도록 보수적으로 잡는다.
 */
export const CHOICE_POST_SEND_STALE_MS = 2 * 60 * 1000; // 2분 — post-selection 별도 발송 claim
export const EMAIL_COUPON_STALE_MS = 2 * 60 * 1000; // 2분 — EMAIL 쿠폰 발송 claim
