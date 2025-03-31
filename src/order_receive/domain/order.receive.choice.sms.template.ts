import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { InternalServerErrorException } from '@nestjs/common';

export const OrderReceiveChoiceSmsTemplate = (orderDelivery: OrderDeliveryEntity) => {
  if (!orderDelivery.choiceSelectProduct) {
    throw new InternalServerErrorException('초이스 쿠폰 선택하지 않앗습니다.');
  }

  return `상품명 : ${orderDelivery.choiceSelectProduct.name}
사용기간 : ${orderDelivery.choiceSelectProduct.expireDay}
쿠폰번호 : ${orderDelivery.barCode}

${orderDelivery.orderProductMapping.order.eventName} 당첨을 축하드립니다.
문의사항은 고객센터 번호를 통해 문의하시길 바랍니다.`;
};
