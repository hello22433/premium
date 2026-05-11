import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';

export const COUPON_CANCELLED_EVENT = 'coupon.cancelled';

export interface CouponCancelledEventPayload {
  orderDeliveryId: number;
  couponStatus: OrderDeliveryCouponStatus.CANCEL | OrderDeliveryCouponStatus.REFUND_CANCEL;
  previousCouponStatus: OrderDeliveryCouponStatus | null;
  cancelledAt: Date;
}
