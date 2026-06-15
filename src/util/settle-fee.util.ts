import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { OrderEntity } from '../entity/order.entity';
import { OrderProductMappingEntity } from '../entity/order.product.mapping.entity';
import { OrderFeeCalculator, applyCardSurcharge } from '../order/domain/order.fee.calculator';
import { IPriceAdjustment } from '../user_discount/interface/price.adjustment';
import { readLineProductView } from '../order/util/order.snapshot.builder';

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
  let price = readLineProductView(mapping).price;
  const fee = getEffectiveFee(delivery, mapping);
  const priceAdjustment = getEffectivePriceAdjustment(delivery, mapping);
  if (fee !== null && priceAdjustment) {
    price = OrderFeeCalculator({ fee, priceAdjustment, price });
  }
  return applyCardSurcharge(price, cardSurchargeApplied);
}

export function calculateMappingSettlementBaseAmount(mapping: OrderProductMappingEntity): number {
  const deliveries = mapping.orderDeliveries ?? [];
  const hasDeliveryFee = deliveries.some((delivery) => delivery.settleFee !== null);

  if (hasDeliveryFee) {
    return deliveries.reduce((total, delivery) => {
      return total + calculateSettlementPrice(mapping, false, delivery);
    }, 0);
  }

  return calculateSettlementPrice(mapping, false) * mapping.amount;
}

/**
 * 주문 전체 정산금액 계산.
 * 정산 저장/수정과 발송확정 차감액이 같은 기준을 사용하도록 주문 전체에 카드할증을 1회 적용한다.
 */
export function calculateOrderSettlementAmount(
  order: Pick<OrderEntity, 'cardSurchargeApplied' | 'orderProductMappings'>,
  cardSurchargeApplied: boolean = order.cardSurchargeApplied,
): number {
  const baseAmount = (order.orderProductMappings ?? []).reduce((orderTotal, mapping) => {
    return orderTotal + calculateMappingSettlementBaseAmount(mapping);
  }, 0);
  return applyCardSurcharge(baseAmount, cardSurchargeApplied);
}
