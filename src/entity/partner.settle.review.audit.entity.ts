import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 원장 review 변경 감사 (append-only · 정본 §5.15.5).
 * CHECK: (ledger_id IS NULL) <> (manual_ledger_proposal_id IS NULL) — XOR.
 */
@Entity('partner_settle_review_audit')
@Index('idx_review_audit_ledger', ['ledgerId', 'createdAt'])
@Index('idx_review_audit_proposal', ['manualLedgerProposalId', 'createdAt'])
export class PartnerSettleReviewAuditEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', nullable: true, comment: '§5.11 ledger review 감사' })
  ledgerId: number | null;

  @Column({ type: 'int', nullable: true, comment: '§5.14 orphan 감사' })
  manualLedgerProposalId: number | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  beforeStatus: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  afterStatus: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  beforeReviewCode: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  afterReviewCode: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  beforeReviewResolution: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  afterReviewResolution: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  beforeOccurredAt: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  afterOccurredAt: Date | null;

  @Column({ type: 'bigint', nullable: true })
  beforeBaseAmount: string | null;

  @Column({ type: 'bigint', nullable: true })
  afterBaseAmount: string | null;

  @Column({ type: 'decimal', precision: 7, scale: 4, nullable: true })
  beforeAppliedPricePercent: string | null;

  @Column({ type: 'decimal', precision: 7, scale: 4, nullable: true })
  afterAppliedPricePercent: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  beforeAppliedPriceAdjustment: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  afterAppliedPriceAdjustment: string | null;

  @Column({ type: 'bigint', nullable: true })
  beforeSettleAmount: string | null;

  @Column({ type: 'bigint', nullable: true })
  afterSettleAmount: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true })
  beforePricingResolution: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true })
  afterPricingResolution: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  providerEvidenceRef: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  providerEvidenceHash: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  priceEvidenceRef: string | null;

  @Column({ type: 'int', nullable: true, comment: 'FK) partner_settle_review_resolution.id' })
  resolutionId: number | null;

  @Column({ type: 'int', comment: '변경 주체' })
  actorId: number;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  reason: string | null;

  @Column({ type: 'datetime', precision: 6 })
  createdAt: Date;
}
