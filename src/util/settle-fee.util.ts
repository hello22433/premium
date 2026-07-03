import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { OrderEntity } from '../entity/order.entity';
import { OrderProductMappingEntity } from '../entity/order.product.mapping.entity';
import { OrderFeeCalculator, applyCardSurcharge } from '../order/domain/order.fee.calculator';
import { IPriceAdjustment } from '../user_discount/interface/price.adjustment';
import { OrderDeliveryCouponStatus } from '../delivery/interface/order.delivery.coupon.status';
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
  const allDeliveries = mapping.orderDeliveries ?? [];
  // 폐기 후 신규발송(재발행)은 원본 행을 지우지 않고 같은 매핑에 새 행을 추가한다
  // (customer.service.service.ts — newDelivery.replacedFromId = 원본 id, settleFee 승계).
  // 재발행분이 원본의 자리를 이어받으므로, 대체된 CANCEL 원본까지 합산하면 이중합산이 된다.
  // 폐기만 하고 재발행하지 않은 CANCEL 행은 기존 동작 유지(정산 반영 정책은 별도 판단).
  // bigint 컬럼(replacedFromId)은 런타임에 string으로 hydrate될 수 있어 Number 정규화 후 비교.
  const replacedIds = new Set(
    allDeliveries
      .filter((delivery) => delivery.replacedFromId !== null && delivery.replacedFromId !== undefined)
      .map((delivery) => Number(delivery.replacedFromId)),
  );
  const deliveries = allDeliveries.filter(
    (delivery) => !(delivery.couponStatus === OrderDeliveryCouponStatus.CANCEL && replacedIds.has(Number(delivery.id))),
  );
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
