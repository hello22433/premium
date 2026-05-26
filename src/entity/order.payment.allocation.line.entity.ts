import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('order_payment_allocation_line')
@Index('idx_allocation_line_order', ['orderId'])
@Index('idx_allocation_line_delivery', ['orderDeliveryId'])
@Index('idx_allocation_line_alloc', ['allocationId'])
export class OrderPaymentAllocationLineEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint' })
  allocationId: string;

  @Column({ type: 'int' })
  orderId: number;

  @Column({ type: 'int' })
  orderProductMappingId: number;

  @Column({ type: 'int', nullable: true, comment: '신규 흐름은 NOT NULL. legacy fallback만 NULL' })
  orderDeliveryId: number | null;

  @Column({ type: 'int', nullable: true })
  productId: number | null;

  @Column({ type: 'int', nullable: true })
  brandId: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  category: string | null;

  @Column({ type: 'int', nullable: true })
  partnerCompanyId: number | null;

  @Column({ type: 'varchar', length: 30 })
  orderType: string;

  @Column({ type: 'int', comment: '카드할증 미포함. calculateSettlementPrice(mapping, false, delivery)' })
  grossSettlementAmount: number;

  @Column({ type: 'int', nullable: true, comment: '발송확정 시점 fee snapshot' })
  appliedFeePercent: number | null;

  @Column({ type: 'varchar', length: 20, nullable: true, comment: 'DISCOUNT | ADDITIONAL | NULL' })
  appliedPriceAdjustment: string | null;

  @Column({ type: 'int', default: 0 })
  pointUsedAmount: number;

  @Column({ type: 'int', comment: '= gross_settlement_amount - point_used_amount' })
  payableBase: number;

  @Column({ type: 'int', default: 0, comment: '정보용. 환불은 풀 기반' })
  depositUsedAmount: number;

  @Column({ type: 'int', default: 0, comment: '정보용' })
  creditUsedAmount: number;

  @Column({ type: 'int', default: 0, comment: '정보용' })
  creditExcessAmount: number;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;
}
