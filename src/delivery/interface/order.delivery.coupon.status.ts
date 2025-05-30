/*
  발행 = NOT_USED
  교환 = USED
  폐기 = CANCEL
  환불폐기 = REFUND_CANCEL
  기간만료 = EXPIRED
*/
export enum OrderDeliveryCouponStatus {
  USED = 'USED',
  NOT_USED = 'NOT_USED',  
  CANCEL = 'CANCEL',
  REFUND_CANCEL = 'REFUND_CANCEL',
  EXPIRED = 'EXPIRED',
}
