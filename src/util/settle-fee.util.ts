import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { OrderEntity } from '../entity/order.entity';
import { OrderProductMappingEntity } from '../entity/order.product.mapping.entity';
import { OrderFeeCalculator, applyCardSurcharge } from '../order/domain/order.fee.calculator';
import { IPriceAdjustment } from '../user_discount/interface/price.adjustment';
import { OrderDeliveryCouponStatus } from '../delivery/interface/order.delivery.coupon.status';
import { IOrderDeliveryStatus } from '../delivery/interface/order.delivery.status';
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

/**
 * 발송건 목록을 주문별 정산 netAmount(카드할증 1회 적용)로 집계한다.
 * - status COMPLETE/COMPLETE_SMS 이고 couponStatus 가 CANCEL(고객사 폐기)이 아닌 건만 합산
 *   (REFUND_CANCEL 수령고객 환불은 고객사 정산 100% 유지 → 포함)
 * - 주문 합계에 카드할증(order.cardSurchargeApplied)을 1회 적용 (발송건별 적용의 비선형 차이 방지)
 * 호출부는 relations 로 orderProductMapping · orderProductMapping.product · orderProductMapping.order 를 로드해야 한다.
 */
export function computeSettleNetAmountByOrder(deliveries: OrderDeliveryEntity[]): Map<number, number> {
  const baseByOrder = new Map<number, number>();
  const surchargeByOrder = new Map<number, boolean>();

  for (const d of deliveries) {
    const order = d.orderProductMapping?.order;
    if (!order) continue;

    const isComplete = d.status === IOrderDeliveryStatus.COMPLETE || d.status === IOrderDeliveryStatus.COMPLETE_SMS;
    if (!isComplete || d.couponStatus === OrderDeliveryCouponStatus.CANCEL) continue;

    baseByOrder.set(
      order.id,
      (baseByOrder.get(order.id) ?? 0) + calculateSettlementPrice(d.orderProductMapping, false, d),
    );
    surchargeByOrder.set(order.id, order.cardSurchargeApplied);
  }

  const netByOrder = new Map<number, number>();
  for (const [orderId, base] of baseByOrder) {
    netByOrder.set(orderId, applyCardSurcharge(base, surchargeByOrder.get(orderId) ?? false));
  }
  return netByOrder;
}

/**
 * 매핑 1건의 정산 기준금액(카드할증 미포함).
 *
 * 표시 라인(buildSettlementDisplayLines)과 "완전히 동일한 분해"를 합산하므로, 화면 합계와
 * 실제 정산금액이 구조적으로 항상 일치한다(차등 판정·재발행 CANCEL 원본 제외 로직을 한 벌로 공유).
 * 단가는 모두 정수(OrderFeeCalculator 반올림)라 그룹 합산(Σ price×amount)과 발송건별 합산(Σ 단가)이
 * 정확히 일치한다.
 *
 * 이 함수는 정산확정 여신차감·발송확정·환불 등 "실제 돈" 경로가 쓰는 SoT 이다(getUserList/Summary/Ids
 * 표시 합계도 동일). 호출부는 mapping.orderDeliveries 를 반드시 로드해야 한다 — 미로드 시 균일 분기로
 * 빠져 발송건별 settleFee 를 무시한 틀린 금액이 조용히 나온다.
 */
export function calculateMappingSettlementBaseAmount(mapping: OrderProductMappingEntity): number {
  return buildSettlementDisplayLines(mapping).reduce((total, line) => total + line.price * line.amount, 0);
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
 * - 비차등(균일 요율) 매핑: 단가 × (주문 수량 − 취소된 발송건 수).
 *   ★ "살아있는 발송건 수" 가 아니다 — 아래 균일 분기의 주석 참조. 필터로 살아남은 목록에는
 *     재발행으로 대체된 원본도 빠져 있는데, 그 경우 재발행분이 원본 자리를 채우므로 청구
 *     수량은 그대로여야 한다. 길이로 세면 재발행 건 금액이 절반이 된다.
 * - 폐기 후 재발행으로 대체된 CANCEL 원본 delivery 는 제외(이중합산 방지 — D3-52).
 *   정산금액 SoT(calculateMappingSettlementBaseAmount)가 이 함수의 결과를 그대로 합산하므로,
 *   화면과 실제 돈이 동일한 필터·분기 기준을 공유한다(로직 중복 없음).
 *   폐기만 하고 재발행하지 않은 CANCEL 은 기존 동작 유지(정산 반영 정책 별도 판단).
 * - 취소된 발송건(delivery.status = CANCEL)은 제외한다(197-16 예약건 부분취소).
 *   그 몫은 이미 환불됐고, 실제 정산확정 금액(getOrderSettlementSummary)도 완료건만 더한다.
 *   빼지 않으면 거래명세서·발송완료리포트가 환불된 건까지 청구한다.
 *   ※ 두 함수가 CANCEL 축에서는 일치하지만 전부 일치하는 것은 아니다 — getOrderSettlementSummary
 *     는 FAIL 도 빼고 이 함수는 남긴다(실패건은 재발송으로 성공시켜 청구하는 것이 정책).
 *     "정산확정과 맞춘다" 는 이유로 여기서 FAIL 을 빼면 안 된다.
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
    (delivery) =>
      // 폐기 후 재발행으로 대체된 원본 (D3-52)
      !(delivery.couponStatus === OrderDeliveryCouponStatus.CANCEL && replacedIds.has(Number(delivery.id))) &&
      // 취소된 발송건 (197-16) — 이미 환불됐으므로 청구 대상이 아니다
      delivery.status !== IOrderDeliveryStatus.CANCEL,
  );

  // 차등정산 여부 판정은 필터 "전" 목록 기준 — calculateMappingSettlementBaseAmount(정산금액 util)와
  // 분기 판정을 일치시켜, 대체된 CANCEL 원본만 settleFee 를 갖는 엣지에서 화면과 정산금액이
  // 서로 다른 분기(균일 vs 차등)를 타는 불일치를 방지한다.
  const hasDeliveryFee = allDeliveries.some((delivery) => delivery.settleFee !== null);
  if (!hasDeliveryFee) {
    // 균일 요율: 단가 1회 계산 × (주문 수량 − 취소된 발송건 수).
    //
    // ★ deliveries.length 를 쓰지 않는 이유: 그 목록은 "폐기 후 재발행으로 대체된 원본"(D3-52)도
    //   빼는데, 그 경우 재발행분이 원본 자리를 채우므로 청구 수량은 그대로여야 한다.
    //   길이로 세면 재발행 건의 금액이 절반이 된다(기존 계약 위반 — settle-fee.util.spec
    //   "delivery-level 요율이 전혀 없는 순수 균일 매핑은 필터 전 기준이어도 균일 분기 유지").
    //   취소는 대체가 아니라 순수 감소이므로 그 수만 뺀다.
    const canceledCount = allDeliveries.filter(
      (delivery) => delivery.status === IOrderDeliveryStatus.CANCEL,
    ).length;
    return [
      { price: calculateSettlementPrice(mapping, false), amount: Math.max(0, mapping.amount - canceledCount) },
    ];
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
