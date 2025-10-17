export enum CustomerServicePinStatus {
  'NOT_USED' = 'NOT_USED', //발행
  'USED' = 'USED', // 교환
  'CANCEL' = 'CANCEL', // 폐기
  'REFUND_CANCEL' = 'REFUND_CANCEL', // 환불폐기
  'EXPIRED' = 'EXPIRED', // 기간만료
}
