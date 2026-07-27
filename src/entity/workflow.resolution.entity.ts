import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { DeliveryWorkflowStatus } from '../delivery/interface/delivery.workflow.status';

/**
 * 불변 수동 종결 레코드. §7.1.
 *
 * `RESOLVED_MANUALLY_*` 는 하위 결과에서 계산되는 값이 아니라 **불변 override** 다.
 * 이 레코드가 존재하면 자동 계산 로직은 workflow 상태를 재계산하지 않으며,
 * 종결 이후 늦게 도착한 PIN/message 하위 결과는 감사 기록만 추가한다.
 *
 * `MANUAL_RESEND`/`PIN_REISSUE` 는 workflow 를 `IN_PROGRESS` 로 **재개**하는 op 이므로
 * 이 레코드를 만들지 않는다(만들면 새 시도 결과를 반영하지 못한다, §6.2 경로별 후처리).
 */
@Entity('workflow_resolution')
@Index('idx_workflow_resolution_approval', ['approvalId'])
export class WorkflowResolutionEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Index('uk_workflow_resolution_delivery', { unique: true })
  @Column({ type: 'int', comment: 'FK) order_delivery.id (1건만 존재)' })
  orderDeliveryId: number;

  @Column({ type: 'varchar', length: 32, comment: 'RESOLVED_MANUALLY_SUCCESS|FAILED|REFUNDED' })
  resolvedStatus: DeliveryWorkflowStatus;

  @Column({ type: 'bigint', comment: '종결 근거 승인(op=OPS_RESOLVE)' })
  approvalId: string;

  @Column({ type: 'bigint', nullable: true, comment: '환불 종결일 때 근거 refund_attempt.id' })
  settledRefundAttemptId: string | null;

  @Column({ type: 'char', length: 64, comment: '승인 payload hash' })
  payloadHash: string;

  @Column({ type: 'bigint', comment: '종결 시점 workflow_version' })
  workflowVersion: string;

  @Column({ type: 'int', comment: '최종 종결 실행자 user.id' })
  resolvedBy: number;

  @Column({ type: 'varchar', length: 1000, comment: '근거(협력사 조회 결과·STAT/RESULT·고객 확인 등)' })
  evidence: string;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;
}
