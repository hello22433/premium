import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

@Entity('order_payment_allocation')
@Unique('uq_order_payment_allocation_order', ['orderId'])
@Index('idx_allocation_wallet', ['walletAccountId'])
export class OrderPaymentAllocationEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'int' })
  orderId: number;

  @Column({ type: 'bigint' })
  walletAccountId: string;

  @Column({ type: 'int', comment: 'Σ line.gross_settlement_amount (카드할증 미포함)' })
  grossSettlementAmount: number;

  @Column({ type: 'int', default: 0 })
  pointUsedAmount: number;

  @Column({ type: 'int', comment: '= card_surcharge_total' })
  payableSettlementAmount: number;

  @Column({ type: 'int', default: 0 })
  depositUsedAmount: number;

  @Column({ type: 'int', default: 0 })
  creditUsedAmount: number;

  @Column({ type: 'int', default: 0 })
  creditExcessAmount: number;

  @Column({ type: 'int', default: 0, comment: '주문 단위 카드할증 풀' })
  cardSurchargeAmount: number;

  @Column({ type: 'tinyint', width: 1, default: 0, comment: '발송확정 시점 snapshot' })
  cardSurchargeApplied: number;

  @Column({ type: 'tinyint', width: 1, default: 0, comment: '할인/할증 적용 여부 (mutex 검증)' })
  hasDiscount: number;

  @Column({ type: 'varchar', length: 20, nullable: true, comment: '발송확정 시점 order.settle_method snapshot' })
  settleMethodSnapshot: string | null;

  @Column({ type: 'int', default: 0 })
  pointRestoredAmount: number;

  @Column({ type: 'int', default: 0 })
  creditExcessRestoredAmount: number;

  @Column({ type: 'int', default: 0 })
  creditUsedRestoredAmount: number;

  @Column({ type: 'int', default: 0 })
  depositRestoredAmount: number;

  @Column({ type: 'int', default: 0, comment: '만료로 복구 안 한 누적 (audit)' })
  pointSkippedExpiredAmount: number;

  @Column({
    type: 'datetime',
    precision: 6,
    nullable: true,
    default: null,
    comment:
      'OrderConfirmationReleaseService 가 보상 TX 로 allocation 을 무효화한 시각. NULL = active wallet-managed (PR2 F-001).',
  })
  releasedAt: Date | null;

  @Column({
    type: 'varchar',
    length: 200,
    nullable: true,
    default: null,
    comment: '보상 사유 (external API timeout / message enqueue failed / manual rollback 등)',
  })
  releaseReason: string | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
