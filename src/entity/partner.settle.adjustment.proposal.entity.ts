import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { IPartnerSettleAdjustmentProposalStatus } from '../partner_settle/interface/partner.settle.adjustment.proposal.status';

/**
 * 정산 차액 제안 (정본 §5.7·§8.5 · PR3C).
 *
 * 소급 재계산(§8.4)으로 시스템이 자동 생성하거나, 운영자가 수동 생성한다.
 * reversal graph 전체를 `resolutionGroupKey` 로 묶어 all-or-nothing 승인/반려.
 *
 * DB CHECK:
 * - 상태별 필드 NULL 조합 (PENDING/APPROVED/REJECTED)
 * - 자기승인 차단 (`created_by IS NULL OR created_by != decided_by`)
 * - system/manual XOR (`chk_adj_proposal_origin`)
 * - 0원 승인 ↔ resultLedgerId 양방향 (`chk_adj_proposal_result`)
 * - amount override 시 사유 필수 (`chk_adj_proposal_override`)
 * - (Step 4) result 복합 FK `(result_ledger_id, id, partner_company_id)` → ledger provenance
 */
@Entity('partner_settle_adjustment_proposal')
@Index('idx_adj_proposal_partner', ['partnerCompanyId'])
@Index('idx_adj_proposal_group', ['resolutionGroupKey', 'status', 'id'])
@Index('idx_adj_proposal_source', ['sourceLedgerId'])
@Index('idx_adj_proposal_cursor', ['createdAt', 'id'])
export class PartnerSettleAdjustmentProposalEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', comment: 'FK) partner_company.id' })
  partnerCompanyId: number;

  @Column({ type: 'varchar', length: 32 })
  subItemKey: string;

  @Column({ type: 'int', nullable: true, comment: 'FK) partner_settle_ledger.id' })
  sourceLedgerId: number | null;

  @Column({ type: 'int', nullable: true, comment: 'FK) partner_discount_history.id — 소급 재계산 dedup 축' })
  discountChangeId: number | null;

  @Column({ type: 'bigint', comment: '시스템/운영자 제안 차액' })
  proposedAmount: string;

  @Column({ type: 'bigint', nullable: true, comment: '승인 확정 금액 (미승인=NULL)' })
  approvedAmount: string | null;

  @Column({ type: 'varchar', length: 1000 })
  reason: string;

  @Column({ type: 'varchar', length: 16, default: 'PENDING' })
  status: IPartnerSettleAdjustmentProposalStatus;

  @Column({ type: 'int', nullable: true, comment: '제안자 (system=NULL)' })
  createdBy: number | null;

  @Column({ type: 'int', nullable: true, comment: '승인/반려자' })
  decidedBy: number | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  decidedAt: Date | null;

  @Column({ type: 'int', nullable: true, comment: '승인 시 생성 ADJUSTMENT ledger' })
  resultLedgerId: number | null;

  @Column({ type: 'varchar', length: 128, nullable: true, comment: '{rootLedgerId}:{discountChangeId}' })
  resolutionGroupKey: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true, comment: '수동 proposal 멱등키' })
  requestKey: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  payloadHash: string | null;

  @Column({ type: 'varchar', length: 8, nullable: true })
  payloadHashVersion: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true, comment: 'approvedAmount != proposedAmount 시 필수' })
  amountOverrideReason: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true, comment: '반려 사유 (반려 필수, 승인 선택)' })
  decisionReason: string | null;
}
