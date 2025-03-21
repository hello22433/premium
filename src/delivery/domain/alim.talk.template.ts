import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { customerName } from '../../const';

export const AlimTalkTemplate = (orderDelivery: OrderDeliveryEntity) => {
  return `상품명 : ${orderDelivery.orderProductMapping.product.name}
사용기간 : ${orderDelivery.orderProductMapping.product.expireDay}
쿠폰번호 : ${orderDelivery.barCode}
사용처 : ${orderDelivery.orderProductMapping.product.brand!.nameKorean}
고객센터 : ${customerName}
발행자 : ${orderDelivery.orderProductMapping.order.user!.businessName}

이 메시지는 알림톡 테스트(test)용 메시지 입니다.
${orderDelivery.orderProductMapping.order.eventName} 당첨을 축하드립니다.
문의사항은 고객센터 번호를 통해 문의하시길 바랍니다.`;
};
