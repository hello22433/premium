import { format } from 'date-fns';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';

export const smsCouponInfoTemplate = (orderDelivery: OrderDeliveryEntity): string => {
  const product = orderDelivery.orderProductMapping.product;
  const expireAt = orderDelivery.expireAt ? format(orderDelivery.expireAt, 'yyyy-MM-dd') : '';

  return `▷상품명: ${product.name}
▷쿠폰번호: ${orderDelivery.barCode}${expireAt ? `\n▷유효기간: ${expireAt} 까지` : ''}`;
};
