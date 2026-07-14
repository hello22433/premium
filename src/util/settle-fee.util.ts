import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { OrderEntity } from '../entity/order.entity';
import { OrderProductMappingEntity } from '../entity/order.product.mapping.entity';
import { OrderFeeCalculator, applyCardSurcharge } from '../order/domain/order.fee.calculator';
import { IPriceAdjustment } from '../user_discount/interface/price.adjustment';
import { readLineProductView } from '../order/util/order.snapshot.builder';
import { OrderDeliveryCouponStatus } from '../delivery/interface/order.delivery.coupon.status';

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

/** 정산 표시용 라인 1행: 실존 단가(price)와 그 단가가 적용된 발송건 수(amount). */
export type SettlementDisplayLine = {
  price: number;
  amount: number;
};

/**
 * 정산 표시용 라인 구성 (D3-49 리뷰 B안 — 요율별 행 분리).
 * 고객사별정산 상세/다중상세와 거래명세서가 동일한 라인 구성을 쓰도록 공유한다.
 *
 * 차등정산(SSG 중복할인 등 delivery.settleFee 보유) 매핑은 발송건마다 요율이 달라
 * 단일 단가가 존재하지 않는다. 라인총액/수량 평균(반올림)을 단가로 내보내면 어느 쿠폰에도
 * 없는 근사값이 되고, 소비측이 price*amount 로 합계를 재구성하면 반올림 오차가 생긴다.
 * 요율 적용 단가별로 행을 분리하면 모든 행의 단가가 실존값이고 price*amount 가 항상 정확한 합계다.
 * (정산정보입력 화면(getOrderSettle 가상 분리 행)과 동일한 표현 방식)
 *
 * - 비차등(균일 요율) 매핑: 단가 × mapping.amount 단일 행.
 * - 폐기 후 재발행으로 대체된 CANCEL 원본 delivery 는 제외(이중합산 방지).
 *   같은 기준의 필터가 calculateMappingSettlementBaseAmount(D3-52 수정)에도 적용 예정이며,
 *   이 루프는 delivery 를 직접 세므로 여기에도 동일 필터가 필요하다.
 *   폐기만 하고 재발행하지 않은 CANCEL 은 기존 동작 유지(정산 반영 정책 별도 판단).
 */
export function buildSettlementDisplayLines(mapping: OrderProductMappingEntity): SettlementDisplayLine[] {
  const allDeliveries = mapping.orderDeliveries ?? [];
  // bigint 컬럼(replacedFromId)은 런타임에 string 으로 hydrate 될 수 있어 Number 정규화 후 비교.
  const replacedIds = new Set(
    allDeliveries
      .filter((delivery) => delivery.replacedFromId !== null && delivery.replacedFromId !== undefined)
      .map((delivery) => Number(delivery.replacedFromId)),
  );
  const deliveries = allDeliveries.filter(
    (delivery) => !(delivery.couponStatus === OrderDeliveryCouponStatus.CANCEL && replacedIds.has(Number(delivery.id))),
  );

  // 차등정산 여부 판정은 필터 "전" 목록 기준 — calculateMappingSettlementBaseAmount(정산금액 util)와
  // 분기 판정을 일치시켜, 대체된 CANCEL 원본만 settleFee 를 갖는 엣지에서 화면과 정산금액이
  // 서로 다른 분기(균일 vs 차등)를 타는 불일치를 방지한다.
  const hasDeliveryFee = allDeliveries.some((delivery) => delivery.settleFee !== null);
  if (!hasDeliveryFee) {
    // 균일 요율: 단가 1회 계산 × 주문 수량
    return [{ price: calculateSettlementPrice(mapping, false), amount: mapping.amount }];
  }

  // 차등정산: 요율 적용 단가별로 발송건 수를 세어 행 분리.
  // 단가 자체를 그룹 키로 쓰므로 각 행에서 price*amount == 발송건별 정확 합계가 보장된다.
  const unitPriceCounts = new Map<number, number>();
  for (const delivery of deliveries) {
    const unitPrice = calculateSettlementPrice(mapping, false, delivery);
    unitPriceCounts.set(unitPrice, (unitPriceCounts.get(unitPrice) ?? 0) + 1);
  }
  return [...unitPriceCounts.entries()].map(([price, amount]) => ({ price, amount }));
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
