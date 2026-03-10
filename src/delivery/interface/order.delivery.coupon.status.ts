/*
  발행 = NOT_USED
  교환 = USED
  폐기 = CANCEL
  환불폐기 = REFUND_CANCEL
  기간만료 = EXPIRED
*/
export enum OrderDeliveryCouponStatus {
  NOT_USED = 'NOT_USED',
  USED = 'USED',
  CANCEL = 'CANCEL',
  REFUND_CANCEL = 'REFUND_CANCEL',
  EXPIRED = 'EXPIRED',
}

const COUPON_STATUS_KOREAN: Record<string, string> = {
  [OrderDeliveryCouponStatus.NOT_USED]: '미사용',
  [OrderDeliveryCouponStatus.USED]: '사용',
  [OrderDeliveryCouponStatus.CANCEL]: '취소',
  [OrderDeliveryCouponStatus.REFUND_CANCEL]: '환불취소',
  [OrderDeliveryCouponStatus.EXPIRED]: '기간만료',
};

export function couponStatusToKorean(status: string): string {
  return COUPON_STATUS_KOREAN[status] ?? status;
}
