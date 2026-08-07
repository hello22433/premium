import { OrderEntity } from '../../entity/order.entity';
import { OrderDeliveryRefundStatusEnum } from '../../delivery/interface/order.delivery.refund.status.enum';
import { IOrderStatus } from '../interface/order.status';
import { DestructionCertificateBlockReason } from '../interface/destruction.certificate.block.reason';
import { resolveOrderEffectiveDestroyAt } from './effective.destroy.date';

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
 * 환불 가드(REFUND_IN_PROGRESS)는 **전량 마스킹이 아닌 주문에서만 평가된다.** 전량 마스킹
 * 주문은 아래 every('-') 블록 안에서 모든 경로가 return 하므로 환불 검사에 도달하지 않는다.
 * 그 블록의 결론은 파기일 축이 정한다 — 답할 수 있으면 발행, 없으면 차단.
 * (초기 요약은 "환불 가드가 미파기 판정보다 **먼저** 반환한다"는 선후 프레임으로 적었는데,
 *  그 프레임 자체가 부정확하다. 두 사유는 순서를 다투는 관계가 아니라 **서로 다른 분기**다.
 *  아래 파기일 축 교차검증 주석 참조 — 리뷰 5차 L-2/M-2.)
 *
 * ★ 파기일 축 교차 검증 (리뷰 3차 H-1)
 *   위 술어는 deliveryTarget 단일이고, 파기일 계산은 deliveryTarget + emailReceiverPhone
 *   2축(isDeliveryDestroyed)이다. 이 비대칭 때문에 두 답이 어긋나는 조합이 실재한다:
 *     delivery_target = '-'  +  email_receiver_phone = <살아있는 암호화 전화번호>
 *   (CS 수신정보 변경의 EMAIL+핀발급 분기가 emailReceiverPhone 만 갱신하기 때문. 그리고
 *    PII 5종 확대 이전에 일부만 마스킹된 레거시 행도 같은 모양이다.)
 *   그 행에서 게이트는 "발행 가능", 파기일은 "아직 안 지움(예정일)"을 답해, **살아있는 PII 옆에
 *   파기 완료 증명서**가 나가거나 파기일 칸이 빈 채로 발행된다. 어느 쪽이든 증빙이 깨진다.
 *   → 술어를 넓히는 대신 **파기일 축을 교차 검증**한다. 날짜가 증빙에 실리므로, 날짜를 답할 수
 *     없는 주문은 애초에 발행할 수 없다는 것이 이 게이트의 원래 의미와도 맞는다.
 *
 *   ⚠️ ACTUAL_ESTIMATED(=백필 역산)는 **막지 않는다.** 컬럼 신설 이전에 파기된 행은 전부
 *      이 성격이므로 막으면 **레거시 주문 전체가 발행 불가**가 된다. 그 행들도 "파기됐다"는
 *      사실 자체는 확정이고(deliveryTarget 이 '-'), 불확실한 것은 날짜뿐이다. 날짜 정확도는
 *      응답의 effectiveDestroyAtKind 로 프론트에 전달해 표기로 처리한다.
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
    // 위 ★ 주석 참조 — 파기일을 답할 수 없으면 발행하지 않는다.
    const destroyAt = resolveOrderEffectiveDestroyAt(order);
    if (destroyAt === null) {
      // 파기는 됐는데 시각 기록이 없다(백필 누락 / 배포 순서 사고). 날짜 칸을 채울 수 없다.
      return { canIssue: false, reason: DestructionCertificateBlockReason.DESTROY_TIME_UNKNOWN };
    }
    if (destroyAt.kind === 'SCHEDULED') {
      // 2축 술어로는 아직 안 지워진 행이 섞여 있다(수신처 부활 / 레거시 부분마스킹).
      // 사유는 NOT_DESTROYED 가 정확하다 — 실제로 남아 있는 PII 가 있다.
      //
      // ⚠️ **결과가 바뀐 조합은 알려진 것만 둘이다.** ('우선순위가 바뀌었다'는 부정확한 표현이다 —
      //    REFUND_IN_PROGRESS 는 every('-') 블록 **밖**이라 전량 마스킹 주문에서는 구·신 코드
      //    모두 구조적으로 도달할 수 없다. 바뀐 것은 순서가 아니라 **허용 → 차단**이다.)
      //    둘 다 종전에는 위 every('-') 에서 곧바로 canIssue: true 였다:
      //      · 전량 마스킹 + emailReceiverPhone 생존 → 여기서 NOT_DESTROYED
      //      · 전량 마스킹 + destroyedAt 결측      → 위에서 DESTROY_TIME_UNKNOWN
      //    ⚠️ 두 조합에 '환불 진행중'을 **한정어로 붙이지 말 것.** 위 리드 문장이 밝혔듯
      //       환불 상태는 이 블록에 영향을 주지 않으므로, 결과가 바뀐 모집단은 환불 진행
      //       여부와 **무관한 전량**이다. '환불 진행중'을 붙이면 배포 후 회귀 범위를 산정하는
      //       사람이 부분집합만 보고 모집단을 과소 추정한다(리뷰 5차 M-5).
      //    의도한 동작이다: "PII 가 남아 있다"·"파기일을 모른다"가 환불 진행 여부보다 앞선
      //    차단 사유이고, 사용자에게도 "환불 때문에 막혔다"보다 정확한 안내다.
      //    ⚠️ 다만 이 분기에 도달했다고 항상 NOT_DESTROYED 인 것은 아니다 — 형제 발송건 하나가
      //       파기일 null 을 내면 주문 전체가 null 이 되어 위 DESTROY_TIME_UNKNOWN 으로 빠진다.
      //    (규모: migration §4-8. 2026-07-31 운영 실측 0건)
      return { canIssue: false, reason: DestructionCertificateBlockReason.NOT_DESTROYED };
    }
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

/**
 * 블록 사유별 사용자 안내 문구.
 * 프론트 BLOCK_MESSAGE(canIssueDestructionCertificate.ts)·조기파기 서비스(early.destroy.service.ts)와
 * 동일한 문구를 유지한다 — 파기 경로(목록/발행/조기파기)에 관계없이 같은 안내를 받아야 한다.
 */
const DEFAULT_BLOCK_MESSAGE = '파기확인서 발행이 불가능합니다.';
const BLOCK_REASON_MESSAGE: Record<DestructionCertificateBlockReason, string> = {
  [DestructionCertificateBlockReason.DELIVERY_NOT_COMPLETE]: '발송 완료된 건에 대해서만 발행 가능합니다.',
  [DestructionCertificateBlockReason.NOT_DESTROYED]: '개인정보 파기가 아직 진행되지 않았습니다.',
  [DestructionCertificateBlockReason.REFUND_IN_PROGRESS]:
    '환불 진행 중인 건으로 파기 실패했습니다. 고객센터(1644-3614)로 문의해주세요.',
  // 파기는 됐으나 시각 기록이 없는 경우. 고객에게 "안 지웠다"고 말하면 거짓이므로 사유를 분리한다.
  // 이 문구가 자주 보이면 백필이 덜 돌았다는 신호다(백필 §4-1 의 마지막 컬럼과 같은 모집단).
  [DestructionCertificateBlockReason.DESTROY_TIME_UNKNOWN]:
    '파기 일자를 확인 중입니다. 고객센터(1644-3614)로 문의해주세요.',
};

export function destructionCertificateBlockMessage(reason: DestructionCertificateBlockReason | null): string {
  return reason ? (BLOCK_REASON_MESSAGE[reason] ?? DEFAULT_BLOCK_MESSAGE) : DEFAULT_BLOCK_MESSAGE;
}
