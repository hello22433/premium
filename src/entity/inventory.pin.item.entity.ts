import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { InventoryPinItemStatus } from '../inventory_coupon/domain/inventory.pin.status';

/**
 * 재고형 쿠폰 PIN item. rev5 §4.5.
 * 암호화 ciphertext/fingerprint를 저장하며 원문은 이 엔티티에 절대 평문 저장하지 않는다.
 */
@Entity('inventory_pin_item')
@Index('uk_item_product_primary_fp', ['productId', 'primaryCodeFingerprint'], { unique: true })
@Index('uk_item_product_pair_fp', ['productId', 'pairFingerprint'], { unique: true })
@Index('uk_item_assigned_delivery', ['assignedOrderDeliveryId'], { unique: true })
@Index('idx_item_allocation', ['productId', 'codeSchemaVersion', 'status', 'expiresOn', 'id'])
@Index('idx_item_batch', ['importBatchId'])
export class InventoryPinItemEntity extends BaseEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'char', length: 26, unique: true, comment: 'AEAD AAD용 불변 ULID' })
  cryptoContextId: string;

  @Column({ type: 'bigint', comment: 'FK) inventory_pin_import_batch.id' })
  importBatchId: string;

  @Column({ type: 'bigint', comment: 'FK) product.id (액면가별 재고 풀 키)' })
  productId: number;

  @Column({ type: 'int', comment: '입고 커밋 시 상품 config의 구조 버전 (이후 불변)' })
  codeSchemaVersion: number;

  @Column({ type: 'text', comment: '주코드 AEAD ciphertext (필수)' })
  primaryCodeCiphertext: string;

  @Column({ type: 'text', nullable: true, comment: '보조코드 AEAD ciphertext (선택)' })
  secondaryCodeCiphertext: string | null;

  @Column({ type: 'varchar', length: 32, comment: 'DB key-ring 조회용 authoritative version' })
  cryptoKeyVersion: string;

  @Column({ type: 'binary', length: 32, comment: 'primary code HMAC-SHA-256 fingerprint' })
  primaryCodeFingerprint: Buffer;

  @Column({ type: 'binary', length: 32, comment: 'primary+secondary canonical pair HMAC' })
  pairFingerprint: Buffer;

  @Column({ type: 'varchar', length: 200, comment: 'primary code 마스킹 표시값' })
  primaryCodeMasked: string;

  @Column({ type: 'varchar', length: 200, nullable: true, comment: 'secondary code 마스킹 표시값' })
  secondaryCodeMasked: string | null;

  @Column({ type: 'varchar', length: 20, default: 'AVAILABLE', comment: 'AVAILABLE/ASSIGNED/VOID' })
  status: InventoryPinItemStatus;

  @Column({ type: 'bigint', nullable: true, comment: '현재 귀속 배송건 ID (UNIQUE, NULL 다수 허용)' })
  assignedOrderDeliveryId: number | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: '할당 시각' })
  assignedAt: Date | null;

  @Column({ type: 'date', nullable: true, comment: 'KST 날짜 기준 유효종료일 (해당 날짜까지 유효)' })
  expiresOn: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: '폐기 시각' })
  voidedAt: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true, comment: '폐기 사유 (PIN 원문 금지)' })
  voidReason: string | null;
}
