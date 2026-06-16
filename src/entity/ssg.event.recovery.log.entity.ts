import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * SSG 행사 잔액 복구 멱등 로그.
 * refund_ledger_id(= order_delivery_refund.id) UNIQUE 제약으로 동일 ledger row 의
 * 두 번째 복구 시도를 차단한다. INSERT 가 ER_DUP_ENTRY 면 이미 복구된 것 → 잔액 미변경.
 */
@Entity('ssg_event_recovery_log')
export class SsgEventRecoveryLogEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Index('uk_ssg_event_recovery_ledger', { unique: true })
  @Column({ type: 'bigint', name: 'refund_ledger_id' })
  refundLedgerId: number;

  @Column({ type: 'int', name: 'ssg_event_id' })
  ssgEventId: number;

  @Column({ type: 'int', name: 'order_id' })
  orderId: number;

  @Column({ type: 'int', name: 'amount' })
  amount: number;

  @Column({
    type: 'datetime',
    precision: 6,
    name: 'applied_at',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  appliedAt: Date;
}
