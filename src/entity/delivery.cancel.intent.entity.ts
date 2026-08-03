import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import {
  DeliveryCancelIntentSource,
  DeliveryCancelIntentStatus,
} from '../delivery/interface/delivery.cancel.intent.status';

@Entity('delivery_cancel_intent')
@Index('idx_delivery_cancel_intent_status', ['status', 'stateEnteredAt'])
export class DeliveryCancelIntentEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Index('uk_delivery_cancel_intent_delivery', { unique: true })
  @Column({ type: 'int' })
  orderDeliveryId: number;

  @Column({ type: 'varchar', length: 24 })
  source: DeliveryCancelIntentSource;

  @Column({ type: 'varchar', length: 24, default: DeliveryCancelIntentStatus.PENDING })
  status: DeliveryCancelIntentStatus;

  @Column({ type: 'varchar', length: 24, nullable: true })
  reconcileFromStatus: DeliveryCancelIntentStatus | null;

  @Column({ type: 'varchar', length: 24 })
  requestedCouponStatus: string;

  @Column({ type: 'boolean', default: true })
  refundRequired: boolean;

  @Column({ type: 'int', nullable: true })
  requestedByUserId: number | null;

  @Column({ type: 'bigint', nullable: true })
  refundAttemptId: string | null;

  @Column({ type: 'int', nullable: true })
  expectedRefundAmount: number | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  expectedRefundScope: string | null;

  @Column({ type: 'varchar', length: 64 })
  ownerToken: string;

  @Column({ type: 'bigint' })
  workflowVersion: string;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  externalCancelledAt: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  resolvedAt: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  failureReason: string | null;

  @Column({ type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  stateEnteredAt: Date;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
