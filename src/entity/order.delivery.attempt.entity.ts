import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum OrderDeliveryAttemptType {
  INITIAL = 'INITIAL',
  RESEND = 'RESEND',
}

export enum OrderDeliveryAttemptStatus {
  PENDING = 'PENDING',
  DEDUCTED = 'DEDUCTED',
  SENT = 'SENT',
  FAILED = 'FAILED',
  ROLLED_BACK = 'ROLLED_BACK',
  COMPLETED = 'COMPLETED',
}

@Entity('order_delivery_attempt')
@Index('idx_delivery_attempt_delivery', ['orderDeliveryId', 'status'])
@Index('idx_delivery_attempt_type', ['attemptType'])
export class OrderDeliveryAttemptEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'int' })
  orderDeliveryId: number;

  @Column({ type: 'varchar', length: 20, comment: 'INITIAL | RESEND' })
  attemptType: OrderDeliveryAttemptType;

  @Column({
    type: 'varchar',
    length: 20,
    default: OrderDeliveryAttemptStatus.PENDING,
    comment: 'PENDING | DEDUCTED | SENT | FAILED | ROLLED_BACK | COMPLETED',
  })
  status: OrderDeliveryAttemptStatus;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @Column({ type: 'datetime', nullable: true, precision: 6 })
  deductedAt: Date | null;

  @Column({ type: 'datetime', nullable: true, precision: 6 })
  sentAt: Date | null;

  @Column({ type: 'datetime', nullable: true, precision: 6 })
  failedAt: Date | null;

  @Column({ type: 'datetime', nullable: true, precision: 6 })
  completedAt: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  failureReason: string | null;
}
