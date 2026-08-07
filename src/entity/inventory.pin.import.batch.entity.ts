import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { InventoryPinImportBatchStatus } from '../inventory_coupon/domain/inventory.pin.status';

/**
 * PIN 엑셀 입고 배치. rev5 §4.4.
 */
@Entity('inventory_pin_import_batch')
export class InventoryPinImportBatchEntity extends BaseEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 200, comment: '실제 구매처명 (필수)' })
  supplierName: string;

  @Column({ type: 'bigint', nullable: true, comment: 'FK) partner_company.id (선택)' })
  sourcePartnerCompanyId: number | null;

  @Column({ type: 'varchar', length: 200, nullable: true, comment: '발주번호/인보이스' })
  purchaseReference: string | null;

  @Column({ type: 'date', nullable: true, comment: '구매일' })
  purchasedAt: string | null;

  @Column({ type: 'varchar', length: 255, comment: '원본 파일명 (표시용, 경로 미포함)' })
  originalFileName: string;

  @Column({ type: 'binary', length: 32, comment: 'SHA-256 파일 체크섬' })
  fileChecksum: Buffer;

  @Column({ type: 'varchar', length: 100, comment: '업로드 요청 멱등키' })
  idempotencyKey: string;

  @Column({ type: 'binary', length: 32, comment: '파일 checksum + 구매처 메타데이터의 canonical hash' })
  requestHash: Buffer;

  @Column({ type: 'char', length: 26, unique: true, comment: '암호화 spool 논리 식별자' })
  spoolId: string;

  @Column({ type: 'varchar', length: 32, comment: '암호화 spool key-ring version' })
  spoolKeyVersion: string;

  @Column({ type: 'datetime', precision: 6, comment: 'orphan/terminal 삭제 상한' })
  spoolExpiresAt: Date;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: '물리 삭제 확인 시각' })
  spoolDeletedAt: Date | null;

  @Column({ type: 'varchar', length: 20, comment: '상태: VALIDATING/COMMITTED/REJECTED' })
  status: InventoryPinImportBatchStatus;

  @Column({ type: 'varchar', length: 64, nullable: true, comment: 'VALIDATING lease 소유자' })
  ownerToken: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: 'stale 복구 기준' })
  leaseUntil: Date | null;

  @Column({ type: 'int', default: 0, comment: '전체 건수' })
  totalCount: number;

  @Column({ type: 'int', default: 0, comment: 'COMMITTED면 total과 동일' })
  committedCount: number;

  @Column({ type: 'int', default: 0, comment: 'REJECTED 오류 수' })
  rejectedCount: number;

  @Column({ type: 'int', comment: '입고 실행 사용자 ID' })
  importedByUserId: number;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: '커밋 시각' })
  committedAt: Date | null;
}
