import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { IPartnerCompanyType } from '../partner_company/interface/partner.company.type';
import { IPartnerSettleSourceType } from '../partner_settle/interface/partner.settle.source.type';
import {
  IPartnerProviderEventOrigin,
  IPartnerProviderEventProcessedStatus,
} from '../partner_settle/interface/partner.provider.event.status';

/**
 * provider 원천 관측 inbox (append-only).
 *
 * 두 lane 이 한 테이블에 공존하며 서로의 규칙을 침범하지 않는다.
 * - **관측 lane** (`origin` POLL|PUSH|MANUAL): snapshot 만 주는 provider(다우 등)의 재발 전이를 저장한다.
 *   row id 가 곧 `unresolvedEvidenceKey = INBOX:{id}` 다. `PENDING → LINKED` 1회 CAS.
 * - **orphan lane** (`origin=ORPHAN`): 시각 누락처럼 자동 원장화가 불가능한 event 를 적재한다.
 *   observation 을 만들지 않으며, `ORPHAN_PENDING` 에서 상호배타 terminal 3종으로만 전이한다.
 *
 * DB 가 강제하는 불변식(마이그레이션 `20260804_partner_credit_pr1b_ledger.sql`):
 * - `UNIQUE(provider, order_delivery_id, ingress_fingerprint)` — 동일 malformed 재수신 1 row 수렴
 * - lane ⇔ processedStatus 상호배타 CHECK, `(origin='ORPHAN') = (ingressFingerprint IS NOT NULL)`
 * - `ORPHAN_AUTO_LEDGERED → manualLedgerProposalId IS NULL` (자동 정산은 proposal 없이 claim)
 *
 * 사실 필드는 불변이다. 갱신 가능한 것은 `observationId`·`processedStatus`·`manualLedgerProposalId` 뿐이다.
 */
@Entity('partner_provider_event_inbox')
@Index('idx_partner_provider_event_inbox_lane', ['provider', 'orderDeliveryId', 'origin', 'id'])
@Index('idx_partner_provider_event_inbox_status', ['processedStatus', 'id'])
export class PartnerProviderEventInboxEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 24, comment: '협력사 type' })
  provider: IPartnerCompanyType;

  @Column({ type: 'int', comment: 'FK) order_delivery.id' })
  orderDeliveryId: number;

  @Column({ type: 'varchar', length: 16, comment: 'ISSUANCE|EXCHANGE|USAGE' })
  sourceType: IPartnerSettleSourceType;

  @Column({ type: 'varchar', length: 16, comment: 'POLL|PUSH|MANUAL|ORPHAN' })
  origin: IPartnerProviderEventOrigin;

  @Column({ type: 'json', comment: '원천 payload 정규화 보존 (증적·불변)' })
  normalizedPayload: Record<string, unknown>;

  @Column({
    type: 'varchar',
    length: 128,
    charset: 'utf8mb4',
    collation: 'utf8mb4_bin',
    comment: '관측 lane append/dedup 판정용 정규화 hash (evidenceKey 아님)',
  })
  payloadFingerprint: string;

  @Column({ type: 'varchar', length: 64, comment: '관측 상태' })
  observedStatus: string;

  @Column({ type: 'datetime', precision: 6, comment: '우리 관측 시각 (occurredAt 아님)' })
  observedAt: Date;

  @Column({ type: 'int', nullable: true, comment: '같은 (delivery, provider) 직전 row' })
  prevInboxRowId: number | null;

  @Column({ type: 'int', nullable: true, comment: 'origin=MANUAL 발급 근거 proposal id (PR1C)' })
  manualProposalId: number | null;

  @Column({ type: 'int', nullable: true, comment: 'orphan lane 수동 승인 proposal id (PR1C)' })
  manualLedgerProposalId: number | null;

  @Column({
    type: 'varchar',
    length: 128,
    charset: 'utf8mb4',
    collation: 'utf8mb4_bin',
    nullable: true,
    comment: 'origin=ORPHAN 만 NOT NULL. 시각 제외 정규화 hash',
  })
  ingressFingerprint: string | null;

  @Column({ type: 'int', nullable: true, comment: '이 row 가 만든 transition observation id' })
  observationId: number | null;

  @Column({
    type: 'varchar',
    length: 24,
    comment: 'PENDING|LINKED|ORPHAN_PENDING|ORPHAN_LEDGERED|ORPHAN_AUTO_LEDGERED|ORPHAN_DISCARDED',
  })
  processedStatus: IPartnerProviderEventProcessedStatus;
}
