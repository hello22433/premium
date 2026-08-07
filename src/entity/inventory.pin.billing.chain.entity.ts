import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { InventoryPinBillingChainState } from '../inventory_coupon/domain/inventory.pin.status';

/**
 * 결제 체인: 최초 고객 차감과 재발급 배송건을 묶는 안정 식별자. rev5 §4.9.
 */
@Entity('inventory_pin_billing_chain')
@Index('uk_chain_wallet_debit', ['walletDebitAllocationId'], { unique: true })
@Index('uk_chain_current_delivery', ['currentOrderDeliveryId'], { unique: true })
export class InventoryPinBillingChainEntity extends BaseEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', unique: true, comment: '최초 wallet 차감/allocation의 불변 ID' })
  walletDebitAllocationId: string;

  @Column({ type: 'bigint', unique: true, comment: '현재 환불·재발급 권한을 소유한 배송건' })
  currentOrderDeliveryId: number;

  @Column({ type: 'decimal', precision: 19, scale: 4, comment: '최초 차감 금액 (이후 불변)' })
  settleAmount: string;

  @Column({ type: 'varchar', length: 20, comment: 'DEBITED/REFUNDED' })
  state: InventoryPinBillingChainState;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: '환불 시각' })
  refundedAt: Date | null;

  @Column({ type: 'int', default: 1, comment: '소유권 이전/환불 CAS' })
  version: number;
}
