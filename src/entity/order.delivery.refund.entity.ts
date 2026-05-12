import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type OrderDeliveryRefundRestoreType = 'BALANCE' | 'COMPANY_BALANCE' | 'ALL_SETTLE_AMOUNT';

export type OrderDeliveryRefundSourcePath =
  | 'CS_DISCARD'
  | 'BATCH_FAIL'
  | 'EXTERNAL_CANCEL'
  | 'EXTERNAL_FAIL'
  | 'ORDER_CANCEL';

/**
 * 환불 멱등성 락 테이블.
 * order_delivery_id UNIQUE 제약으로 동일 발송건의 두 번째 환불 시도를 차단한다.
 * 재발송 성공 시 row를 DELETE 하여 재실패 시 다시 환불할 수 있도록 한다.
 */
@Entity('order_delivery_refund')
export class OrderDeliveryRefundEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Index('uk_order_delivery_refund_delivery', { unique: true })
  @Column({ type: 'int', name: 'order_delivery_id' })
  orderDeliveryId: number;

  @Column({ type: 'int', name: 'user_id' })
  userId: number;

  @Column({ type: 'int', name: 'refund_amount' })
  refundAmount: number;

  @Column({
    type: 'enum',
    enum: ['BALANCE', 'COMPANY_BALANCE', 'ALL_SETTLE_AMOUNT'],
    name: 'restore_type',
  })
  restoreType: OrderDeliveryRefundRestoreType;

  @Column({ type: 'boolean', name: 'is_settle_complete' })
  isSettleComplete: boolean;

  @Column({ type: 'boolean', name: 'is_settle_balance' })
  isSettleBalance: boolean;

  @Column({
    type: 'enum',
    enum: ['CS_DISCARD', 'BATCH_FAIL', 'EXTERNAL_CANCEL', 'EXTERNAL_FAIL', 'ORDER_CANCEL'],
    name: 'source_path',
  })
  sourcePath: OrderDeliveryRefundSourcePath;

  @Column({ type: 'int', name: 'operator_user_id', nullable: true })
  operatorUserId: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  memo: string | null;

  @Column({
    type: 'datetime',
    precision: 6,
    name: 'refunded_at',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  refundedAt: Date;
}
