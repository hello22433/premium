import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { format } from 'date-fns';
import { IProductType } from '../../product/interface/product.type';

export const OrderReceiveSmsTemplate = (orderDelivery: OrderDeliveryEntity) => {
  const productMemo = orderDelivery.orderProductMapping.product.memo
    ? `\n\n${orderDelivery.orderProductMapping.product.memo}`
    : '';

  const productType = orderDelivery.orderProductMapping.product.type;

  // SSG 상품일 경우 쿠폰번호에 personalCode, 인증번호에 barCode 사용
  if (productType === IProductType.SSG) {
    return `상품명 : ${orderDelivery.orderProductMapping.product.name}
유효기간 : ${format(orderDelivery.expireAt!, 'yyyy.MM.dd')} 까지
쿠폰번호 : ${orderDelivery.personalCode}
인증번호 : ${orderDelivery.barCode}

${orderDelivery.orderProductMapping.order.eventName} 당첨을 축하드립니다.
문의사항은 고객센터 번호를 통해 문의하시길 바랍니다.${productMemo}`;
  }

  return `상품명 : ${orderDelivery.orderProductMapping.product.name}
유효기간 : ${format(orderDelivery.expireAt!, 'yyyy.MM.dd')} 까지
쿠폰번호 : ${orderDelivery.barCode}

${orderDelivery.orderProductMapping.order.eventName} 당첨을 축하드립니다.
문의사항은 고객센터 번호를 통해 문의하시길 바랍니다.${productMemo}`;
};
