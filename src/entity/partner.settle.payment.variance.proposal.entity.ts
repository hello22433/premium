import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { IPartnerSettlePaymentVarianceProposalStatus } from '../partner_settle/interface/partner.settle.batch.type';

/**
 * 지급 차이 독립 승인 proposal (정본 §5.7.2 · PR1D).
 *
 * `actualPaidAmount != calculatedPaidAmount` 시 PENDING 으로 생성.
 * 생성은 PR1D(paid 경로), approve/reject 는 PR3A(`PartnerSettlePaymentVarianceService`) 다.
 *
 * DB CHECK:
 * - 상태별 필드 NULL 조합
 * - 자기승인 차단 (`approvedBy != proposedBy`, `rejectedBy != proposedBy`)
 * - batch 당 PENDING proposal 1건 (generated column `activeBatchKey`)
 * - (PR3A) result 복합 FK `(result_ledger_id, id, partner_company_id)` → ledger provenance
 */
@Entity('partner_settle_payment_variance_proposal')
@Index('idx_variance_proposal_batch', ['batchId'])
@Index('idx_variance_proposal_partner', ['partnerCompanyId'])
export class PartnerSettlePaymentVarianceProposalEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', unique: true, comment: 'UNIQUE — 1 request 1 proposal' })
  paymentRequestId: number;

  @Column({ type: 'int', comment: 'FK) partner_settle_batch.id' })
  batchId: number;

  @Column({ type: 'int', comment: 'FK) partner_company.id' })
  partnerCompanyId: number;

  @Column({ type: 'bigint', comment: '요청 당시 지급예정액' })
  calculatedPaidAmount: string;

  @Column({ type: 'bigint', comment: '실제 송금액' })
  actualPaidAmount: string;

  @Column({ type: 'varchar', length: 255 })
  paymentEvidenceRef: string;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  memo: string | null;

  @Column({ type: 'int' })
  proposedBy: number;

  @Column({ type: 'datetime', precision: 6 })
  proposedAt: Date;

  @Column({ type: 'varchar', length: 24, default: 'PENDING' })
  status: IPartnerSettlePaymentVarianceProposalStatus;

  @Column({ type: 'int', nullable: true })
  approvedBy: number | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  approvedAt: Date | null;

  @Column({ type: 'int', nullable: true })
  rejectedBy: number | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  rejectedAt: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  decisionReason: string | null;

  @Column({ type: 'int', nullable: true, comment: '승인 시 생성 ADJUSTMENT ledger' })
  resultLedgerId: number | null;

  // generated column: DB 전용
  // activeBatchKey: number | null;
}
