import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * SSG 재발송 선차감 역복원 멱등 로그.
 *
 * 재발송 시 새 행사로 선차감(deductEventBalance)한 뒤 PIN 재발급/발송이 실패하면 그 선차감을 역복원한다.
 * 이 역복원은 "원래 발송 실패 환불"(ssg_event_recovery_log, refund_ledger_id 키)과는 별개의 deduction 단위라,
 * 같은 order_delivery_refund ledger 키를 재사용하면 기존 recovery_log 와 충돌해 실제 복원이 no-op 된다(HIGH).
 *
 * 따라서 재발송 선차감마다 발급한 고유 resend_deduction_id 를 멱등키로 사용한다.
 * INSERT 가 ER_DUP_ENTRY 면 이미 역복원된 deduction → 잔액 미변경(멱등).
 */
@Entity('ssg_resend_deduct_recovery')
export class SsgResendDeductRecoveryLogEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Index('uk_ssg_resend_deduct_recovery_id', { unique: true })
  @Column({ type: 'varchar', length: 26, name: 'resend_deduction_id' })
  resendDeductionId: string;

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
