import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { InventoryPinReissueStatus } from '../inventory_coupon/domain/inventory.pin.status';

/**
 * 폐기 후 신규 발송(재발급) 이력. rev5 §4.9.
 */
@Entity('inventory_pin_reissue')
@Index('uk_reissue_old_delivery', ['oldOrderDeliveryId'], { unique: true })
@Index('uk_reissue_new_delivery', ['newOrderDeliveryId'], { unique: true })
export class InventoryPinReissueEntity extends BaseEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', unique: true, comment: '기존 배송건 ID' })
  oldOrderDeliveryId: number;

  @Column({ type: 'bigint', unique: true, comment: '신규 배송건 ID' })
  newOrderDeliveryId: number;

  @Column({ type: 'bigint', comment: '기존 PIN item ID' })
  oldInventoryPinItemId: string;

  @Column({ type: 'bigint', comment: '신규 PIN item ID' })
  newInventoryPinItemId: string;

  @Column({ type: 'bigint', comment: 'old/new가 공유하는 결제 체인 ID' })
  inventoryPinBillingChainId: string;

  @Column({ type: 'varchar', length: 20, default: 'COMPLETED', comment: 'COMPLETED만 커밋' })
  status: InventoryPinReissueStatus;

  @Column({ type: 'varchar', length: 500, comment: '사유 (PIN 원문 금지)' })
  reason: string;

  @Column({ type: 'int', comment: '실행 사용자 ID' })
  createdByUserId: number;
}
