import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

export enum OrderPaymentRefundEventType {
  FAIL_REFUND = 'fail_refund',
  DISCARD_REFUND = 'discard_refund',
  CANCEL = 'cancel',
}

@Entity('order_payment_refund_event')
@Unique('uq_refund_event_idempotency', ['idempotencyKey'])
@Index('idx_refund_event_order', ['orderId'])
@Index('idx_refund_event_alloc', ['allocationId'])
export class OrderPaymentRefundEventEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint' })
  allocationId: string;

  @Column({ type: 'int' })
  orderId: number;

  @Column({ type: 'varchar', length: 30, comment: 'fail_refund | discard_refund | cancel' })
  eventType: OrderPaymentRefundEventType;

  @Column({ type: 'json', comment: '이 이벤트에서 환불된 delivery id 배열' })
  affectedDeliveryIds: number[];

  @Column({ type: 'int', comment: 'Σ line.gross_settlement_amount (라인 base, 포인트 포함)' })
  refundedGrossBase: number;

  @Column({ type: 'int', comment: 'Σ (line.gross - line.point_used). 카드할증 base 산정용' })
  refundedPayableBase: number;

  @Column({ type: 'int', comment: 'remaining-payable-base delta로 계산된 카드할증 환불액' })
  refundedCardSurchargeAmount: number;

  @Column({ type: 'int', default: 0 })
  refundedPointAmount: number;

  @Column({ type: 'int', default: 0 })
  refundedDepositAmount: number;

  @Column({ type: 'int', default: 0 })
  refundedCreditUsedAmount: number;

  @Column({ type: 'int', default: 0 })
  refundedCreditExcessAmount: number;

  @Column({ type: 'int', default: 0 })
  pointSkippedExpiredAmount: number;

  @Column({ type: 'varchar', length: 120 })
  idempotencyKey: string;

  @Column({
    type: 'datetime',
    nullable: true,
    precision: 6,
    comment: '재발송 역환불 시 이 ledger를 되돌린 시각',
  })
  reversedAt: Date | null;

  @Column({ type: 'bigint', nullable: true, comment: '역환불을 수행한 wallet_transaction.id' })
  reversedByWalletTransactionId: string | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;
}
