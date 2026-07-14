/**
 * 파기확인서 발행 불가 사유. `null` 이면 발행 가능.
 *
 * 목록 응답(OrderViewDto)이 `canIssueDestructionCertificate` 와 함께 내려주며,
 * 프론트는 사유별 안내 문구를 매핑한다.
 */
export enum DestructionCertificateBlockReason {
  DELIVERY_NOT_COMPLETE = 'DELIVERY_NOT_COMPLETE', // 발송이 완료되지 않음
  NOT_DESTROYED = 'NOT_DESTROYED', // 개인정보 파기가 아직 진행되지 않음
  REFUND_IN_PROGRESS = 'REFUND_IN_PROGRESS', // 환불 진행 중인 발송건이 포함됨
}
