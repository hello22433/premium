import { OrderDeliveryCouponStatus } from './order.delivery.coupon.status';

/**
 * 쿠폰상태 변형(폐기/외부취소/재발행) lease 의 stale 임계 (ms).
 *
 * 변형 작업은 외부 통신(협력사 cancel/issue, 문자 발송)을 포함해 수 초가 걸린다.
 * 크래시로 finally 해제를 못 탄 lease 는 이 시간이 지나면 다음 획득자가 CAS 로 강탈한다(self-heal).
 * 좀비(정지했다 깨어난 소유자)의 뒤늦은 쓰기는 owner-guard(WHERE mutation_claimed_at=:my) 가 차단한다.
 *
 * reSend/resendFailedDelivery 의 RESEND_CLAIM_STALE_MS 와 동일 의미(5분).
 */
export const MUTATION_CLAIM_STALE_MS = 5 * 60 * 1000;

/**
 * 발송해서는 안 되는 쿠폰상태 — 이미 폐기·환불되어 협력사에서 죽은 핀이다.
 *
 * status(WAIT/COMPLETE/FAIL)와 coupon_status(NOT_USED/CANCEL/REFUND_CANCEL)는 **별개 축**이다.
 * 폐기(execDiscard)는 coupon_status 만 CANCEL 로 쓰고 status 는 건드리지 않으므로,
 * status=WAIT + coupon_status=CANCEL / status=COMPLETE + coupon_status=CANCEL 같은 행이 존재한다.
 * status 만 보는 발송 경로는 그 죽은 핀을 그대로 고객에게 보낸다.
 *
 * 발송 경로는 **6개**다. 전부 이 목록을 배제해야 한다:
 *   1. 발송배치            claimWaitDeliveries
 *   2. CS 재발송           reSend
 *   3. CS 재전송           execResend        ← 별개 진입점이다. 4차 리뷰까지 이 목록에서 빠져 있었다
 *   4. 발송실패내역 재발송  resendFailedDelivery
 *   5. 알림톡 SMS 폴백      runReportFallback
 *   6. 외부 API 재발송      resendOrder
 *
 * ⚠️ 새 발송 경로를 추가하면 **이 목록을 먼저 갱신**하라. 목록이 틀리면 그 목록을 믿고 짠
 *    다음 사람이 같은 구멍을 만든다(실제로 그렇게 execResend 가 3라운드 동안 안 보였다).
 */
export const UNSENDABLE_COUPON_STATUSES: OrderDeliveryCouponStatus[] = [
  OrderDeliveryCouponStatus.CANCEL,
  OrderDeliveryCouponStatus.REFUND_CANCEL,
];
