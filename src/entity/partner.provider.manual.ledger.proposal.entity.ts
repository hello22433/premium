import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { IPartnerCompanyType } from '../partner_company/interface/partner.company.type';
import { IPartnerSettleSourceType } from '../partner_settle/interface/partner.settle.source.type';

export type IManualLedgerResolutionMode = 'LEDGER' | 'DISCARD';
export type IManualLedgerProposalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/**
 * 자동 원장화 불가 orphan event 운영자 직접 원장화/폐기 propose→approve (정본 §5.14).
 * galaxia appDay/appTime 누락, 케이티알파 exchDtm 누락 등 안정 멱등키 없는 orphan 전용.
 */
@Entity('partner_provider_manual_ledger_proposal')
export class PartnerProviderManualLedgerProposalEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 24 })
  provider: IPartnerCompanyType;

  @Column({ type: 'int' })
  orderDeliveryId: number;

  @Column({ type: 'varchar', length: 16, comment: '서버 도출 (요청 body 포함 시 400)' })
  sourceType: IPartnerSettleSourceType;

  @Column({ type: 'int', comment: 'FK) orphan lane inbox row (NOT NULL)' })
  inboxRowId: number;

  @Column({ type: 'json', comment: 'inbox normalizedPayload 스냅샷 (불변)' })
  sourceEvidencePayload: Record<string, unknown>;

  @Column({ type: 'json', nullable: true, comment: 'LEDGER면 NOT NULL, DISCARD면 NULL' })
  proposedLedgerFacts: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 16, comment: 'LEDGER|DISCARD' })
  resolutionMode: IManualLedgerResolutionMode;

  @Column({ type: 'varchar', length: 1000, comment: '증적 필수' })
  evidenceRef: string;

  @Column({ type: 'varchar', length: 128 })
  evidenceHash: string;

  @Column({ type: 'varchar', length: 500, comment: '제안 사유 (필수)' })
  reason: string;

  @Column({ type: 'int' })
  proposedBy: number;

  @Column({ type: 'varchar', length: 255, comment: '멱등 키 (UNIQUE)' })
  requestKey: string;

  @Column({ type: 'varchar', length: 128 })
  payloadHash: string;

  @Column({ type: 'varchar', length: 8, default: 'v1' })
  payloadHashVersion: string;

  @Column({ type: 'varchar', length: 128, comment: '{provider,orderDeliveryId,sourceType,inboxRowId}' })
  assertionHash: string;

  @Column({ type: 'varchar', length: 16, comment: 'PENDING|APPROVED|REJECTED' })
  status: IManualLedgerProposalStatus;

  // active_pending_key: DB generated — 원천당 활성 PENDING 1건
  // approved_assertion_key: DB generated — 원천당 APPROVED 1건
  // approved_inbox_binding: DB generated — APPROVED 시 inbox_row_id (양방향 composite FK 용)

  @Column({ type: 'int', nullable: true, comment: 'CHECK(decided_by != proposed_by)' })
  decidedBy: number | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  decidedAt: Date | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  decisionReason: string | null;
}
