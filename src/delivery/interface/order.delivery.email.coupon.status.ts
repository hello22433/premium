export enum OrderDeliveryEmailCouponStatus {
  SEND = 'SEND', // 핀발급 성공 + 문자 발송 성공
  PIN_ISSUED = 'PIN_ISSUED', // 핀발급 성공 + 문자 발송 실패
  FAIL = 'FAIL', // 핀발급 실패
}
