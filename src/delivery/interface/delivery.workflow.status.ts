/**
 * 발송 workflow 전체 업무 상태 (plans/프리미엄_발송실패_재발송_구상.md §5.1).
 *
 * `order_delivery`(쿠폰) 1건당 1행이며 하위 pin_issue_command / message_attempt 결과에서 계산한다.
 * 단, `RESOLVED_MANUALLY_*` 는 하위 결과로 재계산되지 않는 **불변 override** 다(§7.1).
 *
 * - IN_PROGRESS               : 발급/발송 진행 중
 * - PENDING_RECONCILE         : 하위 작업 중 최소 하나가 미확정 → 완료·정산·환불 차단
 * - OPS_REVIEW_REQUIRED       : SLA 초과·불명확 결과로 운영 확인 필요(미종결, 자체 에스컬레이션 SLA 보유)
 * - COMPLETED                 : 쿠폰 전달 완료(채널 하나라도 최종 성공)
 * - FAILED_FINAL              : 최종 실패 확정
 * - CANCELLED                 : 주문 취소에 따른 종결(발송 실패 아님, 사유 코드 보유)
 * - RESOLVED_MANUALLY_SUCCESS : DUAL_APPROVAL 수동 성공 종결
 * - RESOLVED_MANUALLY_FAILED  : DUAL_APPROVAL 수동 실패 종결
 * - RESOLVED_MANUALLY_REFUNDED: 승인이 지목한 refund_attempt 가 SUCCEEDED 임이 확인된 환불 종결
 *                               (`settled_refund_attempt_id` 필수, §5.1·§6.1 HIGH 1)
 */
export enum DeliveryWorkflowStatus {
  IN_PROGRESS = 'IN_PROGRESS',
  PENDING_RECONCILE = 'PENDING_RECONCILE',
  OPS_REVIEW_REQUIRED = 'OPS_REVIEW_REQUIRED',
  COMPLETED = 'COMPLETED',
  FAILED_FINAL = 'FAILED_FINAL',
  CANCELLED = 'CANCELLED',
  RESOLVED_MANUALLY_SUCCESS = 'RESOLVED_MANUALLY_SUCCESS',
  RESOLVED_MANUALLY_FAILED = 'RESOLVED_MANUALLY_FAILED',
  RESOLVED_MANUALLY_REFUNDED = 'RESOLVED_MANUALLY_REFUNDED',
}

/**
 * Level A 배타 슬롯을 점유하는 operation 11종 (§6.1 표 2-1).
 *
 * 한 `order_delivery` 에는 동시에 하나의 배타 op 만 존재한다. 슬롯 점유는 단일 조건부 UPDATE 로만
 * 이뤄지며, op 별 허용 workflow 상태와 op 별 가드를 WHERE 에 포함한다(API 검증에 의존하지 않는다).
 */
export enum DeliveryExclusiveOp {
  /** 최초 발송·채널 폴백 등 신규 메시지 시도 생성 */
  MESSAGE_SEND = 'MESSAGE_SEND',
  /** 최초 협력사 PIN 발급 명령 생성(명령이 하나도 없을 때만) */
  PIN_ISSUE = 'PIN_ISSUE',
  /** 신규 협력사 PIN 발급 재호출(OPS_REVIEW_REQUIRED + DUAL 전용) */
  PIN_REISSUE = 'PIN_REISSUE',
  /** 자동 재시도 실행(PIN 재시도 / 504 예약 재발송) */
  RETRY = 'RETRY',
  /** 운영자 수동 재발송(기존 PIN 재사용, 신규 발급 아님) */
  MANUAL_RESEND = 'MANUAL_RESEND',
  /** 예약(RETRY_SCHEDULED) 재발송 취소 */
  CANCEL_RESEND = 'CANCEL_RESEND',
  /** 제출된 미발송 건(OUTBOX_READY/SUBMITTING/SUBMITTED/TRACKING)의 취소 */
  CANCEL_INFLIGHT_SEND = 'CANCEL_INFLIGHT_SEND',
  /** 결과 재조정·지연 결과 반영·재발급 재검토 승격 */
  RECONCILE = 'RECONCILE',
  /** DUAL 최종 수동 종결(WF·PIN 공용) */
  OPS_RESOLVE = 'OPS_RESOLVE',
  /** 환불 실행(refund_attempt claim) */
  REFUND = 'REFUND',
  /** 폐기 */
  DISCARD = 'DISCARD',
}

/**
 * `OPS_REVIEW_REQUIRED` 승격 사유 (§6.3·§7.1).
 */
export enum OpsReviewReason {
  /** 상태별 최대 체류시간(표 4-1) 초과 */
  SLA_EXCEEDED = 'SLA_EXCEEDED',
  /** 최종 실패 후 지연 성공 보고 재상정 */
  LATE_RESULT_REVIEW = 'LATE_RESULT_REVIEW',
  /** FAILED_FINAL 건의 PIN 재발급 재검토 승격 */
  REISSUE_REVIEW = 'REISSUE_REVIEW',
  /** 환불 실행 여부 불명(refund_attempt UNKNOWN) */
  REFUND_UNKNOWN = 'REFUND_UNKNOWN',
  /** 취소 성사 여부 불명(cancel intent UNKNOWN_REQUIRES_OPS) */
  CANCEL_UNKNOWN = 'CANCEL_UNKNOWN',
}

/**
 * 슬롯 점유 실패 원인별 응답 코드 (§6.1 "슬롯 점유 실패 응답").
 *
 * 조건부 UPDATE 의 `affected = 0` 은 원인이 여러 갈래이므로 하나의 코드로 뭉치지 않는다.
 * 후속 SELECT 로 원인을 구분해 클라이언트가 "재시도 가능/상태 충돌/재조정 대기"를 알 수 있게 한다.
 */
export enum DeliverySlotFailureCode {
  /** 다른 배타 작업이 유효 lease 로 점유 중 — 잠금 해제 후 재시도 가능 */
  DELIVERY_OPERATION_LOCKED = 'DELIVERY_OPERATION_LOCKED',
  /** op 허용 workflow 상태가 아님 — 상태 충돌이라 재시도 무의미 */
  DELIVERY_OPERATION_NOT_ALLOWED = 'DELIVERY_OPERATION_NOT_ALLOWED',
  /** CANCEL_RESEND 인데 RETRY_SCHEDULED 예약이 없음 */
  DELIVERY_RESEND_NOT_SCHEDULED = 'DELIVERY_RESEND_NOT_SCHEDULED',
  /** MANUAL_RESEND 인데 환불이 성공/진행 중(재무 누수 차단) */
  DELIVERY_REFUND_BLOCKS_RESEND = 'DELIVERY_REFUND_BLOCKS_RESEND',
  /** CANCEL_INFLIGHT_SEND 인데 취소 대상 in-flight attempt 가 없음 */
  DELIVERY_NO_INFLIGHT_SEND = 'DELIVERY_NO_INFLIGHT_SEND',
  /** MESSAGE_SEND/PIN_ISSUE/RETRY 가 op 별 재조정·중복 가드에 걸림 */
  DELIVERY_RECONCILE_IN_PROGRESS = 'DELIVERY_RECONCILE_IN_PROGRESS',
  /** OPS_RESOLVE 환불 종결인데 승인이 지목한 성공 refund_attempt 가 없음 */
  DELIVERY_REFUND_NOT_SETTLED = 'DELIVERY_REFUND_NOT_SETTLED',
  /** 대상 workflow 행 없음 */
  DELIVERY_WORKFLOW_NOT_FOUND = 'DELIVERY_WORKFLOW_NOT_FOUND',
}
