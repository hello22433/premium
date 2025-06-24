import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { customerName } from '../../const';

export const AlimTalkTemplate = (orderDelivery: OrderDeliveryEntity) => {
  const couponCode =
    orderDelivery.orderProductMapping.order.user!.businessName === 'SSG'
      ? orderDelivery.personalCode
      : orderDelivery.barCode;

  return `상품명 : ${orderDelivery.orderProductMapping.product.name}
유효기간 : ${orderDelivery.orderProductMapping.product.expireDay}일
쿠폰번호 : ${couponCode}
사용처 : ${orderDelivery.orderProductMapping.product.brand!.nameKorean}
고객센터 : ${customerName}
발행자 : ${orderDelivery.orderProductMapping.order.user!.businessName}

${orderDelivery.orderProductMapping.order.eventName} 당첨을 축하드립니다.
문의사항은 고객센터 번호를 통해 문의하시길 바랍니다.
이 메시지는 고객님의 동의에 의해 지급된 쿠폰 안내 메시지입니다.`;
};
