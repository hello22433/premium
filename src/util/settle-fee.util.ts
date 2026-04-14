import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { OrderProductMappingEntity } from '../entity/order.product.mapping.entity';
import { OrderFeeCalculator, applyCardSurcharge } from '../order/domain/order.fee.calculator';
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

/**
 * 정산단가 계산 (할인/할증 + 카드할증 적용)
 * 폐기/실패 환불, 정산확정 등에서 공통으로 사용
 */
export function calculateSettlementPrice(
  mapping: OrderProductMappingEntity,
  cardSurchargeApplied: boolean,
  delivery?: OrderDeliveryEntity,
): number {
  let price = mapping.product.price;
  const fee = getEffectiveFee(delivery, mapping);
  const priceAdjustment = getEffectivePriceAdjustment(delivery, mapping);
  if (fee !== null && priceAdjustment) {
    price = OrderFeeCalculator({ fee, priceAdjustment, price });
  }
  return applyCardSurcharge(price, cardSurchargeApplied);
}
