import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { InventoryPinEmailOutboxState } from '../inventory_coupon/domain/inventory.pin.status';

/**
 * 직접 PIN 이메일 durable outbox. rev5 §4.8.
 * Phase-A 커밋 후 프로세스 종료돼도 발송 복구 보장.
 */
@Entity('inventory_pin_email_outbox')
@Index('uk_outbox_delivery', ['orderDeliveryId'], { unique: true })
export class InventoryPinEmailOutboxEntity extends BaseEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', unique: true, comment: '배송건당 outbox 한 건' })
  orderDeliveryId: number;

  @Column({ type: 'varchar', length: 20, default: 'PENDING', comment: 'PENDING/CLAIMED/PAUSED/DONE/VOID' })
  state: InventoryPinEmailOutboxState;

  @Column({ type: 'datetime', precision: 6, comment: '다음 처리 예정 시각' })
  dueAt: Date;

  @Column({ type: 'varchar', length: 64, nullable: true, comment: 'lease 소유자 토큰' })
  ownerToken: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: 'lease 만료 시각' })
  leaseUntil: Date | null;

  @Column({ type: 'int', default: 0, comment: '시도 횟수' })
  attemptCount: number;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '다음 attempt의 durable command key' })
  pendingRequestKey: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '최근 오류 코드 (redacted)' })
  lastErrorCode: string | null;
}
