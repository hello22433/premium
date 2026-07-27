import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import {
  DeliveryExclusiveOp,
  DeliveryWorkflowStatus,
  OpsReviewReason,
} from '../delivery/interface/delivery.workflow.status';

/**
 * 발송 workflow 전체 업무 상태 + Level A 배타 슬롯 앵커.
 * plans/프리미엄_발송실패_재발송_구상.md §5.1 / §6.1.
 *
 * - `order_delivery`(쿠폰) 1:1. 서로 다른 쿠폰은 각자 독립 슬롯을 가져 직렬화되지 않는다.
 * - 배타가 필요한 모든 operation 은 **단일 조건부 UPDATE** 로 슬롯을 점유하고 `workflowVersion` 을 +1 한다.
 *   → "상태 확인 직후 다른 작업이 선점"하는 TOCTOU 경쟁이 원자적으로 제거된다.
 * - 외부 응답 반영은 `ownerToken` + `generation` + `workflowVersion` 3중 fencing 일치일 때만 한다.
 * - `cutoverMigratedAt IS NOT NULL` 인 행은 legacy 진입점(`resendFailedDelivery` 등)을 거부하고
 *   이 workflow 가 화면·정산 판단의 유일한 SoT 다(§8·§9 컷오버 계약).
 */
@Entity('delivery_workflow')
@Index('idx_delivery_workflow_status', ['workflowStatus', 'stateEnteredAt'])
@Index('idx_delivery_workflow_slot', ['activeExclusiveOp', 'exclusiveLeaseExpiresAt'])
@Index('idx_delivery_workflow_cutover', ['cutoverMigratedAt'])
export class DeliveryWorkflowEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Index('uk_delivery_workflow_delivery', { unique: true })
  @Column({ type: 'int', comment: 'FK) order_delivery.id (1:1, 쿠폰 단위)' })
  orderDeliveryId: number;

  @Column({ type: 'varchar', length: 32, default: DeliveryWorkflowStatus.IN_PROGRESS })
  workflowStatus: DeliveryWorkflowStatus;

  @Column({ type: 'bigint', default: 0, comment: 'fencing 카운터. 슬롯 점유/해제/전이마다 +1' })
  workflowVersion: string;

  @Column({ type: 'varchar', length: 24, nullable: true, comment: '배타 슬롯 점유 op. NULL=공석' })
  activeExclusiveOp: DeliveryExclusiveOp | null;

  @Column({ type: 'varchar', length: 64, nullable: true, comment: '슬롯 소유자 토큰(ABA 방지)' })
  exclusiveOwnerToken: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: '슬롯 리스 만료. 경과 시 회수 가능' })
  exclusiveLeaseExpiresAt: Date | null;

  @Column({ type: 'boolean', default: false, comment: '쿠폰 단위 전달완료 플래그(채널 하나라도 최종 성공)' })
  deliveredFlag: boolean;

  @Column({ type: 'varchar', length: 16, nullable: true, comment: '전달 성공 채널' })
  deliveredChannel: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  deliveredAt: Date | null;

  @Column({
    type: 'bigint',
    nullable: true,
    comment: 'RESOLVED_MANUALLY_REFUNDED 종결 근거의 단일 출처 (refund_attempt.id)',
  })
  settledRefundAttemptId: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: '환불 확정 표식. 재발송 후보 영구 제외' })
  refundedAt: Date | null;

  @Column({ type: 'varchar', length: 16, nullable: true, comment: '환불 표식 상태 SUCCEEDED|FAILED|UNKNOWN' })
  refundStatus: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true, comment: 'CANCELLED 종결 사유 코드' })
  cancelReasonCode: string | null;

  @Column({
    type: 'datetime',
    precision: 6,
    default: () => 'CURRENT_TIMESTAMP(6)',
    comment: '현재 workflowStatus 진입 시각(SLA 체류시간 기준)',
  })
  stateEnteredAt: Date;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: 'OPS_REVIEW_REQUIRED 승격 시각' })
  opsEscalatedAt: Date | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  opsReviewReason: OpsReviewReason | null;

  @Column({
    type: 'datetime',
    precision: 6,
    nullable: true,
    comment: '컷오버 전환 마크. NOT NULL 이면 legacy 진입점 거부 + workflow 가 유일 SoT',
  })
  cutoverMigratedAt: Date | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
