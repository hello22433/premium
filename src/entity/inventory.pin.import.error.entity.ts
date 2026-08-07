import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * PIN 입고 검증 오류 (redacted). rev5 §4.4.
 */
@Entity('inventory_pin_import_error')
export class InventoryPinImportErrorEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', comment: 'FK) inventory_pin_import_batch.id' })
  batchId: string;

  @Column({ type: 'int', comment: '엑셀 행 번호' })
  rowNumber: number;

  @Column({ type: 'varchar', length: 100, comment: '오류 필드' })
  field: string;

  @Column({ type: 'varchar', length: 100, comment: '오류 코드' })
  errorCode: string;

  @Column({ type: 'varchar', length: 200, nullable: true, comment: '마스킹된 식별자 (PIN 원문 금지)' })
  maskedIdentifier: string | null;
}
