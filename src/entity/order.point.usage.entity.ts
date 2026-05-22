import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('order_point_usage')
@Index('idx_order_point_usage_order', ['orderId'])
@Index('idx_order_point_usage_delivery', ['orderDeliveryId'])
@Index('idx_order_point_usage_grant', ['pointGrantId'])
export class OrderPointUsageEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint' })
  allocationId: string;

  @Column({ type: 'int' })
  orderId: number;

  @Column({ type: 'int', nullable: true })
  orderDeliveryId: number | null;

  @Column({ type: 'bigint' })
  pointGrantId: string;

  @Column({ type: 'int' })
  usedAmount: number;

  @Column({ type: 'int', default: 0 })
  restoredAmount: number;

  @Column({ type: 'int', default: 0 })
  skippedExpiredAmount: number;

  @Column({ type: 'datetime', nullable: true })
  expiresAtSnapshot: Date | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
