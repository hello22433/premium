import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { DeliveryWorkflowStatus } from '../delivery/interface/delivery.workflow.status';
import { RefundAttemptStatus, RefundEntryPath, RefundScope } from '../delivery/interface/refund.attempt.status';

/**
 * 환불 외부 부작용 상태 머신(4번째 상태 머신). §5.4.
 *
 * PG/지갑/legacy 환불 호출은 DB 트랜잭션 **밖**에서 하므로 "DB 먼저 종결 → 외부 환불 실패"와
 * "외부 환불 성공 → DB 반영 전 크래시"를 상태 모델로 닫는다.
 *
 * - 미확정(CLAIMED/SUBMITTING/RECONCILING/UNKNOWN)은 order_delivery 당 최대 1건.
 *   DB generated column `in_flight_key` unique 로 물리 강제한다(중복 환불 차단).
 * - lease 만료·응답 유실 시 신규 attempt 를 만들지 않고 기존 claim 을 `RECONCILING` 으로 회수해
 *   외부 idempotency key/조회 API 로 재조정한다. blind 재환불 금지.
 * - `FAILED`(외부 미실행 확정) 이후에만 **새 external idempotency key** 로 신규 attempt 를 열 수 있다.
 *   `UNKNOWN` 이후에는 열지 않고 DUAL 수동 종결로만 닫는다.
 * - `amount`·`scope`·`approvalId` 는 `§10` 불변식 ①이 승인 payload 와 실제 실행값을 조인 검증하는 근거다.
 */
@Entity('refund_attempt')
@Index('idx_refund_attempt_delivery', ['orderDeliveryId', 'status'])
@Index('idx_refund_attempt_status', ['status', 'stateEnteredAt'])
@Index('idx_refund_attempt_approval', ['approvalId'])
export class RefundAttemptEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'int', comment: 'FK) order_delivery.id' })
  orderDeliveryId: number;

  @Column({ type: 'varchar', length: 16, default: RefundAttemptStatus.CLAIMED })
  status: RefundAttemptStatus;

  @Column({ type: 'char', length: 1, comment: 'A=OPS_REVIEW_REQUIRED 경유(DUAL) / B=종결 상태 환불' })
  entryPath: RefundEntryPath;

  @Column({ type: 'int', comment: '환불 금액(승인 payload 와 대조)' })
  amount: number;

  @Column({ type: 'varchar', length: 16 })
  scope: RefundScope;

  @Index('uk_refund_attempt_idem', { unique: true })
  @Column({ type: 'varchar', length: 191, comment: '외부 환불 idempotency key(중복 환불 방지)' })
  externalIdempotencyKey: string;

  @Column({ type: 'varchar', length: 64, nullable: true, comment: 'Level B 실행 lease 소유자' })
  ownerToken: string | null;

  @Column({ type: 'bigint', default: 0, comment: 'Level B 세대(3중 fencing)' })
  generation: string;

  @Column({ type: 'bigint', nullable: true, comment: '바인딩된 workflow_version(3중 fencing)' })
  workflowVersion: string | null;

  @Column({ type: 'bigint', nullable: true, comment: '경로 A 의 DUAL claim 승인 id. 경로 B 는 NULL' })
  approvalId: string | null;

  @Column({ type: 'varchar', length: 24, default: 'REFUND', comment: '생성 출처 op(감사 일관성)' })
  createdByOp: string;

  @Column({ type: 'bigint', comment: '생성 시점 workflow_version' })
  createdWorkflowVersion: string;

  @Column({
    type: 'varchar',
    length: 32,
    nullable: true,
    comment: '환불 시작 시점 workflow_status. 경로 B UNKNOWN 승격을 되돌릴 때의 복원 기준(§5.4)',
  })
  entryWorkflowStatus: DeliveryWorkflowStatus | null;

  @Column({ type: 'varchar', length: 500, nullable: true, comment: 'FAILED/UNKNOWN 사유(민감정보 금지)' })
  failureReason: string | null;

  @Column({
    type: 'bigint',
    nullable: true,
    comment: '외부 환불 콜백이 실제 종료된 세대. NULL 이면 in-flight 가능성이 남아 미실행(FAILED) 확정 금지(§6.1)',
  })
  executionQuiescedGeneration: string | null;

  @Column({
    type: 'datetime',
    precision: 6,
    default: () => 'CURRENT_TIMESTAMP(6)',
    comment: '현재 status 진입 시각(표 4-1 체류시간)',
  })
  stateEnteredAt: Date;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  resolvedAt: Date | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
