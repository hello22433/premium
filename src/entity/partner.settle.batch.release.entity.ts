import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';

/**
 * 확정 해제 감사 (정본 §5.8 · PR1D · append-only).
 *
 * 건별/배치 해제 시 해제된 원장 row 수만큼 append 한다.
 * `confirmedTotalAmount`/`confirmedCount` 는 변경하지 않는다.
 * `UNIQUE(batchId, ledgerId)` 로 동일 batch·row 중복 감사를 차단한다.
 */
@Entity('partner_settle_batch_release')
@Index('idx_release_ledger', ['ledgerId'])
@Index('idx_release_request', ['releaseRequestId'])
export class PartnerSettleBatchReleaseEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', comment: 'FK) partner_settle_batch.id' })
  batchId: number;

  @Column({ type: 'int', comment: 'FK) partner_settle_ledger.id' })
  ledgerId: number;

  @Column({ type: 'int', comment: 'FK) partner_settle_batch_release_request.id' })
  releaseRequestId: number;

  @Column({ type: 'int' })
  releasedBy: number;

  @Column({ type: 'datetime', precision: 6 })
  releasedAt: Date;

  @Column({ type: 'varchar', length: 500 })
  reason: string;
}
