import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';

export type IReviewResolutionMode = 'SET_TIME' | 'SET_PRICE' | 'SET_UNKNOWN' | 'RECLASSIFY' | 'DISCARD';

export type IReviewResolutionStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/**
 * NEEDS_REVIEW 원장 해소 propose→approve 2단계 (정본 §5.11).
 * 단순 재계산(COVERAGE_GAP/POLICY_CONFLICT)은 대상 아님 — recalculate API 소관.
 */
@Entity('partner_settle_review_resolution')
@Index('idx_review_resolution_ledger', ['ledgerId'])
export class PartnerSettleReviewResolutionEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', comment: 'FK) partner_settle_ledger.id' })
  ledgerId: number;

  @Column({ type: 'varchar', length: 32, comment: 'propose 시점 ledger reviewCode 스냅샷' })
  reviewCode: string;

  @Column({ type: 'varchar', length: 16, comment: 'SET_TIME|SET_PRICE|SET_UNKNOWN|RECLASSIFY|DISCARD' })
  resolutionMode: IReviewResolutionMode;

  @Column({ type: 'json', nullable: true, comment: '모드별 확정값' })
  proposedValues: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 1000, nullable: true, comment: '증적 참조' })
  evidenceRef: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true, comment: '증적 정규화 hash' })
  evidenceHash: string | null;

  @Column({ type: 'varchar', length: 255, comment: '멱등 키 (UNIQUE)' })
  requestKey: string;

  @Column({ type: 'varchar', length: 128 })
  payloadHash: string;

  @Column({ type: 'varchar', length: 8, default: 'v1' })
  payloadHashVersion: string;

  @Column({ type: 'varchar', length: 16, comment: 'PENDING|APPROVED|REJECTED' })
  status: IReviewResolutionStatus;

  @Column({ type: 'int' })
  proposedBy: number;

  @Column({ type: 'datetime', precision: 6 })
  proposedAt: Date;

  @Column({ type: 'int', nullable: true })
  decidedBy: number | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  decidedAt: Date | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  decisionReason: string | null;

  // generated: CASE WHEN status='PENDING' THEN ledger_id END — DB only
}
