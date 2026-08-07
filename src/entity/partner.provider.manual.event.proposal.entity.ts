import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { IPartnerCompanyType } from '../partner_company/interface/partner.company.type';
import { IPartnerSettleSourceType } from '../partner_settle/interface/partner.settle.source.type';

export type IManualEventProposalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/**
 * MANUAL 발급 propose→approve (정본 §5.13).
 * 승인 대기 manual 제안을 inbox 상태 체인에서 분리해, 자동 polling이 미승인 row에 막히는 결함을 해소.
 */
@Entity('partner_provider_manual_event_proposal')
export class PartnerProviderManualEventProposalEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 24 })
  provider: IPartnerCompanyType;

  @Column({ type: 'int' })
  orderDeliveryId: number;

  @Column({ type: 'varchar', length: 16 })
  sourceType: IPartnerSettleSourceType;

  @Column({ type: 'json' })
  proposedPayload: Record<string, unknown>;

  @Column({ type: 'varchar', length: 128, charset: 'utf8mb4', collation: 'utf8mb4_bin' })
  payloadFingerprint: string;

  @Column({ type: 'varchar', length: 64 })
  observedStatus: string;

  @Column({ type: 'varchar', length: 1000, comment: 'MANUAL은 증적 필수' })
  evidenceRef: string;

  @Column({ type: 'varchar', length: 128 })
  evidenceHash: string;

  @Column({ type: 'int' })
  proposedBy: number;

  @Column({ type: 'varchar', length: 255, comment: '멱등 키 (UNIQUE)' })
  requestKey: string;

  @Column({ type: 'varchar', length: 128 })
  payloadHash: string;

  @Column({ type: 'varchar', length: 8, default: 'v1' })
  payloadHashVersion: string;

  @Column({ type: 'varchar', length: 16, comment: 'PENDING|APPROVED|REJECTED' })
  status: IManualEventProposalStatus;

  // active_pending_key: DB generated — 대상당 활성 PENDING 1건

  @Column({ type: 'int', nullable: true, comment: 'CHECK(decided_by != proposed_by)' })
  decidedBy: number | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  decidedAt: Date | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  decisionReason: string | null;

  @Column({
    type: 'int',
    nullable: true,
    comment: '승인 시 생성된 MANUAL inbox row — composite FK 로 inbox↔proposal 양방향 강제',
  })
  inboxRowId: number | null;
}
