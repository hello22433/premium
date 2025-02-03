export enum IOrderStatus {
  TEMP = 'TEMP', // 임시 저장
  DELIVERY_REQUEST = 'DELIVERY_REQUEST', // 발송 요청 = 주문완료
  DELIVERY_CONFIRMED = 'DELIVERY_CONFIRMED', // 발송 대기 = 발송 확정
  DELIVERY_COMPLETE = 'DELIVERY_COMPLETE', // 발송 완료
  DELIVERY_CANCEL = 'DELIVERY_CANCEL', //발송 취소`
}
