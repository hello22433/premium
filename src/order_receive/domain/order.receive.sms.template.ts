import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';

export const OrderReceiveSmsTemplate = (orderDelivery: OrderDeliveryEntity) => {
  return `상품명 : ${orderDelivery.orderProductMapping.product.name}
사용기간 : ${orderDelivery.orderProductMapping.product.expireDay}
쿠폰번호 : ${orderDelivery.barCode}

${orderDelivery.orderProductMapping.order.eventName} 당첨을 축하드립니다.
문의사항은 고객센터 번호를 통해 문의하시길 바랍니다.`;
};
