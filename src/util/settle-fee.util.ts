import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { OrderProductMappingEntity } from '../entity/order.product.mapping.entity';
import { IPriceAdjustment } from '../user_discount/interface/price.adjustment';

/**
 * delivery.settleFee ?? mapping.fee 폴백 규칙 중앙화
 * SSG 중복할인 적용 건은 delivery.settleFee에 fee가 저장되며,
 * 비SSG 또는 미설정 SSG는 mapping.fee를 사용한다.
 */
export function getEffectiveFee(
  delivery: Pick<OrderDeliveryEntity, 'settleFee'> | undefined | null,
  mapping: Pick<OrderProductMappingEntity, 'fee'>,
): number | null {
  return delivery?.settleFee ?? mapping.fee;
}

export function getEffectivePriceAdjustment(
  delivery: Pick<OrderDeliveryEntity, 'settlePriceAdjustment'> | undefined | null,
  mapping: Pick<OrderProductMappingEntity, 'priceAdjustment'>,
): IPriceAdjustment | null {
  return delivery?.settlePriceAdjustment ?? mapping.priceAdjustment;
}
