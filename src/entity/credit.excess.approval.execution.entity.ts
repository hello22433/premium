import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * 신용초과 승인 실행 표식.
 *
 * 발송확정 트랜잭션과 **같은 트랜잭션**에서 1회만 기록된다. 모든 lifecycle 모드
 * (WALLET/LEGACY/SHADOW) 공통이며, 최종화(PROCESSING → COMPLETED)와 lease 복구는
 * 이 표식의 존재·토큰 일치 여부만으로 판정한다.
 */
@Entity('credit_excess_approval_execution')
@Unique('uq_credit_excess_execution_approval', ['approvalId'])
@Index('idx_credit_excess_execution_order', ['orderId'])
export class CreditExcessApprovalExecutionEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', comment: 'credit_excess_approval.id (1:1)' })
  approvalId: string;

  @Column({ type: 'int' })
  orderId: number;

  @Column({ type: 'varchar', length: 64, comment: '기록 시점 approval.attempt_token' })
  attemptToken: string;

  @Column({ type: 'varchar', length: 20, comment: '실행 시점 WALLET_PR2_DELIVERY_LIFECYCLE_MODE' })
  lifecycleMode: string;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;
}
