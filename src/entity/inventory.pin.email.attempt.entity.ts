import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import {
  InventoryPinEmailAttemptStatus,
  InventoryPinEmailAttemptType,
} from '../inventory_coupon/domain/inventory.pin.status';

/**
 * 직접 PIN 이메일 발송 시도. rev5 §4.6.
 * claim-token CAS로 완료하며 PIN 원문을 오류 메시지에 저장하지 않는다.
 */
@Entity('inventory_pin_email_attempt')
@Index('uk_attempt_delivery_request', ['orderDeliveryId', 'requestKey'], { unique: true })
@Index('uk_attempt_active_delivery', ['activeOrderDeliveryId'], { unique: true })
export class InventoryPinEmailAttemptEntity extends BaseEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', comment: 'FK) inventory_pin_item.id' })
  inventoryPinItemId: string;

  @Column({ type: 'bigint', comment: 'FK) order_delivery.id' })
  orderDeliveryId: number;

  @Column({ type: 'varchar', length: 100, comment: '동일 발송 명령 멱등키' })
  requestKey: string;

  @Column({ type: 'varchar', length: 20, comment: 'INITIAL/RESEND' })
  attemptType: InventoryPinEmailAttemptType;

  @Column({ type: 'varchar', length: 20, comment: 'CLAIMED/SENT/FAILED/UNKNOWN' })
  status: InventoryPinEmailAttemptStatus;

  /**
   * CLAIMED일 때만 orderDeliveryId, 그 외 NULL.
   * generated stored column + UNIQUE로 배송건별 동시 CLAIMED 최대 1건을 강제.
   */
  @Column({ type: 'bigint', nullable: true, comment: 'CLAIMED일 때만 orderDeliveryId (generated UNIQUE)' })
  activeOrderDeliveryId: number | null;

  @Column({ type: 'int', comment: 'claim 시점 수신정보 버전' })
  targetVersion: number;

  @Column({ type: 'varchar', length: 64, comment: '소유권 CAS 토큰' })
  claimToken: string;

  @Column({ type: 'datetime', precision: 6, comment: '메일 호출 전 커밋 시각' })
  claimedAt: Date;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: '완료 시각' })
  completedAt: Date | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: 'PIN 없는 결과 코드만' })
  providerCode: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '정규화 오류 코드' })
  errorCode: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true, comment: 'PIN/본문/수신 이메일 원문 금지' })
  errorMessage: string | null;
}
