/**
 * DUAL_APPROVAL(four-eyes) 승인 상태 (§8.2).
 *
 * 승인은 특정 payload `hash` 와 `workflow_version` 에 바인딩되며, 대상 상태가 바뀌면 자동 무효화된다.
 * 실행 시에는 5개 fencing 조건(`approvalId` + `op` + `orderDeliveryId` + `boundWorkflowVersion` +
 * `status='APPROVED'`)을 **하나의 조건부 UPDATE 안에서** 검증한다(§6.2).
 */
export enum DualApprovalStatus {
  /** 요청됨(승인 0~1건) */
  PENDING = 'PENDING',
  /** 독립 2인 승인 완료 — 실행 가능 */
  APPROVED = 'APPROVED',
  /** 승인자 반려 */
  REJECTED = 'REJECTED',
  /** workflow_version·payload 변동으로 자동 무효화 */
  INVALIDATED = 'INVALIDATED',
  /** 실행에 사용됨(1회성) */
  CONSUMED = 'CONSUMED',
}

/**
 * 승인 흐름 append-only 감사 이벤트 (§8.2 불변 감사 로그).
 */
export enum DualApprovalAuditEvent {
  REQUESTED = 'REQUESTED',
  APPROVED_FIRST = 'APPROVED_FIRST',
  APPROVED_SECOND = 'APPROVED_SECOND',
  REJECTED = 'REJECTED',
  INVALIDATED = 'INVALIDATED',
  CONSUMED = 'CONSUMED',
}

/**
 * DUAL 승인이 필요한 operation (§6.1·§8.1).
 *
 * `REFUND` 는 경로 A(`OPS_REVIEW_REQUIRED` 경유)만 DUAL 이고, 경로 B(종결 상태 환불)는 슬롯 fencing 만 쓴다.
 */
export const DUAL_APPROVAL_OPS = ['OPS_RESOLVE', 'MANUAL_RESEND', 'PIN_REISSUE', 'REFUND'] as const;

export type DualApprovalOp = (typeof DUAL_APPROVAL_OPS)[number];
