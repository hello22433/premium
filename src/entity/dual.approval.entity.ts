import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { DualApprovalOp, DualApprovalStatus } from '../delivery/interface/dual.approval.status';
import { DeliveryWorkflowStatus } from '../delivery/interface/delivery.workflow.status';
import { RefundScope } from '../delivery/interface/refund.attempt.status';

/**
 * DUAL_APPROVAL(four-eyes) 승인 레코드. §8.2.
 *
 * 정책 문구가 아니라 시스템으로 강제한다.
 * - 요청자·1차 승인자·2차 승인자는 서로 다른 계정이어야 한다(DB CHECK + 애플리케이션 검증).
 * - 승인은 특정 payload `hash` 와 `boundWorkflowVersion` 에 바인딩된다. 대상 상태·payload 가 바뀌면
 *   기존 승인은 무효화(`INVALIDATED`)되고 재승인을 요구한다.
 * - **승인은 `op` 단위로만 유효하다.** 같은 delivery·같은 workflowVersion 의 `MANUAL_RESEND` 승인으로
 *   `PIN_REISSUE` 를 실행할 수 없다. 런타임 조건부 UPDATE 와 §10 검증 모두
 *   `approvalId` + `op` + `orderDeliveryId` + `boundWorkflowVersion` + `status='APPROVED'` 5개를 함께 요구한다.
 * - `hash` 만으로는 사후 대조가 불가능하므로 실행 대상 값(`refundAttemptId`·`amount`·`scope`)을
 *   컬럼으로 materialize 한다. 컬럼과 `payloadHash` 가 불일치하면 승인을 무효로 간주한다.
 */
@Entity('dual_approval')
@Index('idx_dual_approval_target', ['orderDeliveryId', 'op', 'status'])
@Index('idx_dual_approval_version', ['orderDeliveryId', 'boundWorkflowVersion'])
@Index('idx_dual_approval_expires', ['status', 'expiresAt'])
export class DualApprovalEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'int', comment: 'FK) order_delivery.id (포괄 승인 금지)' })
  orderDeliveryId: number;

  @Column({ type: 'varchar', length: 24, comment: 'OPS_RESOLVE|MANUAL_RESEND|PIN_REISSUE|REFUND' })
  op: DualApprovalOp;

  @Column({ type: 'varchar', length: 16, default: DualApprovalStatus.PENDING })
  status: DualApprovalStatus;

  @Column({ type: 'char', length: 64, comment: '승인 payload SHA-256(위·변조 검증)' })
  payloadHash: string;

  @Column({ type: 'bigint', comment: '승인이 바인딩한 workflow_version. 변동 시 자동 무효화' })
  boundWorkflowVersion: string;

  @Column({ type: 'varchar', length: 32, nullable: true, comment: 'OPS_RESOLVE 승인 시 목표 종결 상태' })
  resolvedStatus: DeliveryWorkflowStatus | null;

  @Column({ type: 'bigint', nullable: true, comment: '환불 종결 근거로 지목한 refund_attempt.id' })
  refundAttemptId: string | null;

  @Column({ type: 'int', nullable: true, comment: '환불 승인 금액' })
  amount: number | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  scope: RefundScope | null;

  @Column({ type: 'varchar', length: 191, nullable: true, comment: 'REFUND 승인 payload 의 외부 idempotency key' })
  externalIdempotencyKey: string | null;

  @Column({ type: 'int', comment: '요청자 user.id' })
  requestedBy: number;

  @Column({ type: 'varchar', length: 500, comment: '요청 사유(필수)' })
  requestedReason: string;

  @Column({ type: 'int', nullable: true, comment: '1차 승인자(요청자와 달라야 함)' })
  firstApproverId: number | null;

  @Column({ type: 'int', nullable: true, comment: '2차 승인자(요청자·1차와 달라야 함)' })
  secondApproverId: number | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  firstApprovedAt: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  secondApprovedAt: Date | null;

  @Column({ type: 'datetime', precision: 6, comment: '승인 만료 시각. 만료 후 실행 불가' })
  expiresAt: Date;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: '실행에 사용된 시각(1회성)' })
  consumedAt: Date | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
