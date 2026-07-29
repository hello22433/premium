import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { IOrderType } from '../interface/order.type';

/**
 * 발송 취소 마감 — 실발송 예정 시각으로부터 이만큼 남아 있어야 취소할 수 있다.
 * (부분취소 SQL 게이트 findCancelableDeliveryIds 와 화면 표시용 evaluateDeliveryCancelable 이
 *  공유하는 단일 소스. order.service.ts 는 이 상수를 import 한다.)
 *
 * 이 값은 5분 주기 발송 배치(issueAndSend)와 짝을 이룬다. 배치는 send_request_at < 실행시각 인
 * 행만 집으므로, "이 값 이상 남은 행" 과 "배치가 집는 행" 은 조건상 겹치지 않는다 —
 * 취소 처리 도중 같은 행이 발송돼 버리는 창을 구조적으로 막는 장치다.
 * 실질 여유 = 이 값 ~ 이 값 + 배치주기(5분). 즉 지금 값이면 10~15분이다.
 *
 * evaluateDeliveryCancelable 은 화면 표시용(advisory)이고, 실제 취소 게이트는
 * findCancelableDeliveryIds(SQL) + cancelDeliveriesIfStillWaiting(CAS) 다. 둘이 갈라지면
 * "화면엔 취소 가능인데 서버는 400"(fail-closed, 돈은 안 움직임)이 난다.
 */
export const DELIVERY_CANCEL_CUTOFF_MS = 10 * 60 * 1000;

/**
 * 발송건을 지금 취소할 수 없는 이유. null 이면 취소 가능.
 * FE 는 이 코드를 툴팁/비활성 사유로 매핑한다(문구는 FE 소유).
 */
export enum DeliveryCancelBlockReason {
  /** 발송 대기(WAIT) 상태가 아님 — 이미 완료/실패/취소되었거나 임시 상태 */
  NOT_WAITING = 'NOT_WAITING',
  /** 이미 발송됨 (actualSendAt 세팅 — 외부 API 성공은 status 를 WAIT 로 두므로 이 값을 본다) */
  ALREADY_SENT = 'ALREADY_SENT',
  /** 쿠폰(PIN/바코드)이 이미 발급됨 */
  ALREADY_ISSUED = 'ALREADY_ISSUED',
  /** 발송 배치가 이미 집어갔거나(claimed) 발송결과가 기록됨 — 곧 나감 */
  IN_PROGRESS = 'IN_PROGRESS',
  /** 외부 연동(EXTERNAL) 주문 — 이 경로로 취소 불가 */
  EXTERNAL_ORDER = 'EXTERNAL_ORDER',
  /** 발송 예정 시각까지 컷오프(기본 10분) 미만 남음 */
  CUTOFF_PASSED = 'CUTOFF_PASSED',
  /**
   * 주문 레벨에서 부분취소를 지원하지 않는 주문 — 발송건 조건과 무관하게 엔드포인트가 거부한다.
   * 현재: SSG 주문(행사잔액 발송건별 복구 미지원, partialDeliveryCancel 이 SSG 를 400 으로 선차단).
   * ★ 이 사유는 발송건 술어(evaluateDeliveryCancelable)가 아니라 주문 조립부(getDetail)에서
   *   order.type 으로 판정한다 — findCancelableDeliveryIds(발송건 SQL)에는 없는 order-level 게이트라
   *   술어의 발송건 7조건과 분리해 둔다.
   */
  UNSUPPORTED_ORDER = 'UNSUPPORTED_ORDER',
}

/**
 * evaluateDeliveryCancelable 이 판정에 쓰는 발송건 필드의 최소 집합.
 * OrderDeliveryEntity 가 이 shape 을 만족하므로 엔티티를 그대로 넘겨도 된다.
 */
export interface DeliveryCancelableView {
  status: IOrderDeliveryStatus;
  actualSendAt: Date | null;
  claimedAt: Date | null;
  couponIssuedAt: Date | null;
  barCode: string | null;
  reportState: unknown | null;
  sendRequestAt: Date | null;
}

/**
 * "이 발송건을 지금 취소할 수 있는가" 를 로드된 엔티티 필드만으로 판정한다(추가 쿼리 없음).
 *
 * ★ findCancelableDeliveryIds(order.service.ts)의 SQL 조건집합과 **1:1 로 일치**해야 한다.
 *   그쪽이 권위값(취소는 그 결과의 부분집합만 허용)이고 여기는 화면 표시용이다. 조건을 바꾸면
 *   반드시 양쪽을 함께 바꾸고 delivery.cancelable.spec.ts 로 어긋남을 잡는다.
 *
 * 조건(모두 만족해야 취소 가능):
 *   1) status = WAIT
 *   2) actualSendAt IS NULL
 *   3) claimedAt IS NULL
 *   4) reportState IS NULL
 *   5) couponIssuedAt IS NULL AND barCode IS NULL
 *   6) order.type != EXTERNAL
 *   7) sendRequestAt >= now + cutoff
 *
 * 판정 순서는 "더 확정적인 사유" 를 먼저 노출한다(이미 발송 > 컷오프 등).
 */
export function evaluateDeliveryCancelable(
  delivery: DeliveryCancelableView,
  orderType: IOrderType,
  now: Date,
  cutoffMs: number = DELIVERY_CANCEL_CUTOFF_MS,
): { cancelable: boolean; blockReason: DeliveryCancelBlockReason | null } {
  const block = (reason: DeliveryCancelBlockReason) => ({ cancelable: false, blockReason: reason });

  if (delivery.status !== IOrderDeliveryStatus.WAIT) {
    return block(DeliveryCancelBlockReason.NOT_WAITING);
  }
  if (delivery.actualSendAt !== null) {
    return block(DeliveryCancelBlockReason.ALREADY_SENT);
  }
  if (delivery.couponIssuedAt !== null || delivery.barCode !== null) {
    return block(DeliveryCancelBlockReason.ALREADY_ISSUED);
  }
  if (delivery.claimedAt !== null || delivery.reportState !== null) {
    return block(DeliveryCancelBlockReason.IN_PROGRESS);
  }
  if (orderType === IOrderType.EXTERNAL) {
    return block(DeliveryCancelBlockReason.EXTERNAL_ORDER);
  }
  // sendRequestAt 이 없으면(즉시발송 등 예약 아님) 컷오프 판정 불가 → 취소 대상 아님으로 본다.
  // ★ `== null` 로 null 과 undefined 를 함께 막는다. 로더 배선 오류로 이 필드가 undefined 로
  //   들어오면 `=== null` 은 빠져나가 .getTime() 에서 TypeError → 주문상세 전체 500 이 된다.
  //   판정 불가 상황은 항상 "취소 불가"(fail-closed)로 떨어뜨려 조회를 깨지 않는다.
  if (delivery.sendRequestAt == null || delivery.sendRequestAt.getTime() < now.getTime() + cutoffMs) {
    return block(DeliveryCancelBlockReason.CUTOFF_PASSED);
  }

  return { cancelable: true, blockReason: null };
}
