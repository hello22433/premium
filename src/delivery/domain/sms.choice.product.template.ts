import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { IProductType } from '../../product/interface/product.type';

export const SmsChoiceProductTemplate = (orderDelivery: OrderDeliveryEntity, url: string, text: string) => {
  if (orderDelivery.orderProductMapping.product.type === IProductType.CHOICE && !orderDelivery.choiceSelectProductId) {
    return text + `\n\n초이스 쿠폰 받기 링크 : ${url}`;
  }
  return text;
};
