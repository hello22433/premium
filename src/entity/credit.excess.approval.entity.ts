import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

export enum CreditExcessApprovalStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
}

@Entity('credit_excess_approval')
@Unique('uq_credit_excess_consumed', ['id', 'consumedAt'])
@Index('idx_credit_excess_order', ['orderId'])
@Index('idx_credit_excess_status', ['status'])
export class CreditExcessApprovalEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'int' })
  orderId: number;

  @Column({ type: 'bigint' })
  walletAccountId: string;

  @Column({ type: 'int', comment: '발송확정 시점 payable_settlement_amount' })
  requestedAmount: number;

  @Column({ type: 'int', comment: '신용초과 분배 예상액' })
  requestedCreditExcessAmount: number;

  @Column({ type: 'varchar', length: 200, comment: 'Step B 사유 (필수)' })
  reasonText: string;

  @Column({ type: 'int', comment: '요청한 user.id (기업관리자)' })
  requestedBy: number;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  requestedAt: Date;

  @Column({
    type: 'varchar',
    length: 20,
    default: CreditExcessApprovalStatus.PENDING,
    comment: 'PENDING | APPROVED | REJECTED | EXPIRED',
  })
  status: CreditExcessApprovalStatus;

  @Column({ type: 'int', nullable: true, comment: '승인/거절한 user.id (운영관리자)' })
  approvedBy: number | null;

  @Column({ type: 'datetime', nullable: true, precision: 6 })
  approvedAt: Date | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  rejectReason: string | null;

  @Column({
    type: 'datetime',
    nullable: true,
    precision: 6,
    comment: '발송확정에서 사용된 시각 (조건부 UPDATE로 1회만 사용 보장)',
  })
  consumedAt: Date | null;
}
