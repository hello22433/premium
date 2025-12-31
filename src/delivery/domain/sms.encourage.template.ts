import { format } from 'date-fns';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';

export const smsEncourageTemplate = (orderDelivery: OrderDeliveryEntity) => {
  return `미사용 쿠폰에 대한 유효기간 안내

쿠폰 만료일: ${format(orderDelivery.expireAt!, 'yyyy-MM-dd')}

※기간 만료시 재발송, 기간연장, 환불 등 처리불가`;
};