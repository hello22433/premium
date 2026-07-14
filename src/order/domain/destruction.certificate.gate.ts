import { OrderEntity } from '../../entity/order.entity';
import { OrderDeliveryRefundStatusEnum } from '../../delivery/interface/order.delivery.refund.status.enum';
import { IOrderStatus } from '../interface/order.status';
import { DestructionCertificateBlockReason } from '../interface/destruction.certificate.block.reason';

/**
 * 파기 완료 마커. 정기파기(delivery.batch.service)·조기파기(early.destroy.service)가
 * PII 를 마스킹할 때 쓰는 값과 동일해야 한다.
 */
const DESTROY_VALUE = '-';

export interface DestructionCertificateGateResult {
  canIssue: boolean;
  reason: DestructionCertificateBlockReason | null;
}

/**
 * 파기확인서 발행 가능 여부 판정.
 *
 * 판정 컬럼은 `deliveryTarget` 단일이다(0710/backend-response 문서 참조).
 *  - PII 5종 중 `deliveryTarget` 만 NOT NULL 이고, 정기파기 배치는 NULL 컬럼을 재수집하지
 *    않으므로 5종 전수(every === '-') 판정은 영구 발행 불가 행을 만든다.
 *  - CS 수신처 조회 가드·마스킹 유틸·확인서 페이지 진입 검증이 모두 이 컬럼 하나로
 *    파기 여부를 판정한다 — 같은 술어를 써야 게이트 통과 후 페이지에서 튕기지 않는다.
 *
 * 환불 가드(REFUND_IN_PROGRESS)는 "미파기" 판정보다 먼저 반환하되, 전량 파기 완료면
 * 환불 여부와 무관하게 발행 가능하다 — 이미 지운 주문의 확인서를 막을 이유가 없다.
 *
 * order.orderProductMappings(.orderDeliveries) 가 로드된 엔티티를 전제한다.
 */
export function resolveDestructionCertificateGate(order: OrderEntity): DestructionCertificateGateResult {
  if (order.status !== IOrderStatus.DELIVERY_COMPLETE) {
    return { canIssue: false, reason: DestructionCertificateBlockReason.DELIVERY_NOT_COMPLETE };
  }

  const deliveries = (order.orderProductMappings ?? []).flatMap((mapping) => mapping.orderDeliveries ?? []);

  // 발송건이 없으면 파기할 대상 자체가 없다 — 확인서가 증명할 내용이 없으므로 발행 불가.
  if (deliveries.length === 0) {
    return { canIssue: false, reason: DestructionCertificateBlockReason.NOT_DESTROYED };
  }

  if (deliveries.every((delivery) => delivery.deliveryTarget === DESTROY_VALUE)) {
    return { canIssue: true, reason: null };
  }

  const hasRefundInProgress = deliveries.some(
    (delivery) =>
      delivery.refundStatus === OrderDeliveryRefundStatusEnum.PROGRESS ||
      delivery.refundStatus === OrderDeliveryRefundStatusEnum.APPROVE,
  );
  if (hasRefundInProgress) {
    return { canIssue: false, reason: DestructionCertificateBlockReason.REFUND_IN_PROGRESS };
  }

  return { canIssue: false, reason: DestructionCertificateBlockReason.NOT_DESTROYED };
}
