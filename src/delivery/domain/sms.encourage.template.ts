import { format } from 'date-fns';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';

export const smsEncourageTemplate = (orderDelivery: OrderDeliveryEntity) => {
  return `쿠폰 기간만료안내

만료일: ${format(orderDelivery.expireAt!, 'yyyy-MM-dd')}

※기간만료시 재발송/기간연장/환불 불가`;
};