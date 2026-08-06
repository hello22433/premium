import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { IPartnerCompanyType } from '../partner_company/interface/partner.company.type';
import {
  IPartnerSettleSourceEventIdOrigin,
  IPartnerSettleSourceType,
} from '../partner_settle/interface/partner.settle.source.type';
import { IPartnerSettleObservationResolutionStatus } from '../partner_settle/interface/partner.provider.event.status';

/**
 * 협력사 정산 상태전이 관측.
 *
 * 두 종류만 존재하고 DB CHECK 로 갈린다.
 * - **정상 감지**: provider 증적으로 검증된 불변 ID 가 있다. `sourceEventIdOrigin='PROVIDER'` ·
 *   `observationKey = EXC:{provider}:{sourceType}:{sourceEventId}` · 생성 시 `RESOLVED` 이며
 *   같은 트랜잭션에서 ledger 가 `transitionSequenceNo=1` 로 append 된다.
 * - **미복원**: 전이 시퀀스를 복원할 수 없다. ledger placeholder 없이 `UNRESOLVED` 로 보관하고
 *   `unresolvedBaseKey + unresolvedEvidenceKey` 를 영구 identity 로 쓴다. 해소(PR1C)는 승인 2단계다.
 *
 * **활성 UNRESOLVED 1건 UNIQUE 를 두지 않는다** — E1 미해소 중 실제 새 전이 E2 가 오면 삼켜지기 때문이다.
 * 재스캔 중복은 `(unresolvedBaseKey, unresolvedEvidenceKey)` 전역 UNIQUE 가 담당한다.
 *
 * `generation` 은 감사용 표기일 뿐이다. identity·중복차단에 쓰지 않으며 자동 증가시키지 않는다.
 */
@Entity('partner_settle_transition_observation')
@Index('idx_partner_settle_observation_delivery', ['orderDeliveryId', 'sourceType'])
@Index('idx_partner_settle_observation_resolution', ['resolutionStatus'])
export class PartnerSettleTransitionObservationEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', comment: 'FK) order_delivery.id' })
  orderDeliveryId: number;

  @Column({ type: 'varchar', length: 16, comment: 'ISSUANCE|EXCHANGE|USAGE' })
  sourceType: IPartnerSettleSourceType;

  @Column({ type: 'varchar', length: 32, comment: '전이 전 상태' })
  prevStatus: string;

  @Column({ type: 'varchar', length: 32, comment: '전이 후 상태' })
  newStatus: string;

  @Column({ type: 'varchar', length: 24, comment: '협력사 type' })
  provider: IPartnerCompanyType;

  @Column({
    type: 'varchar',
    length: 255,
    charset: 'utf8mb4',
    collation: 'utf8mb4_bin',
    nullable: true,
    comment: '정상 관측만 NOT NULL (증적으로 검증된 불변 ID)',
  })
  sourceEventId: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true, comment: 'PROVIDER 또는 NULL' })
  sourceEventIdOrigin: IPartnerSettleSourceEventIdOrigin | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: '원천 발생 시각' })
  sourceOccurredAt: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true, comment: '원천 monotonic version (자동발번 금지)' })
  sourceVersion: string | null;

  @Column({ type: 'datetime', precision: 6, comment: '관측 시각' })
  observedAt: Date;

  @Column({
    type: 'varchar',
    length: 255,
    charset: 'utf8mb4',
    collation: 'utf8mb4_bin',
    comment: '영구 identity (UNIQUE)',
  })
  observationKey: string;

  @Column({
    type: 'varchar',
    length: 255,
    charset: 'utf8mb4',
    collation: 'utf8mb4_bin',
    nullable: true,
    comment: 'UNRES:{provider}:{orderDeliveryId}:{sourceType}. 미복원만 NOT NULL',
  })
  unresolvedBaseKey: string | null;

  @Column({
    type: 'varchar',
    length: 255,
    charset: 'utf8mb4',
    collation: 'utf8mb4_bin',
    nullable: true,
    comment: '재현 가능한 근거 (payload fingerprint / INBOX:{id}). 미복원만 NOT NULL',
  })
  unresolvedEvidenceKey: string | null;

  @Column({ type: 'int', nullable: true, comment: '감사용 발생 순번 표기 전용' })
  generation: number | null;

  @Column({ type: 'varchar', length: 16, comment: 'RESOLVED|UNRESOLVED' })
  resolutionStatus: IPartnerSettleObservationResolutionStatus;

  @Column({ type: 'varchar', length: 64, nullable: true })
  firstSeenRunId: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  lastSeenRunId: string | null;

  @Column({ type: 'int', nullable: true, comment: 'FK) user.id — 해소 기안자 (PR1C)' })
  resolutionProposedBy: number | null;

  @Column({ type: 'int', nullable: true, comment: 'FK) user.id — 해소 승인자 (PR1C)' })
  resolutionApprovedBy: number | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  resolvedAt: Date | null;

  @Column({ type: 'varchar', length: 128, nullable: true, comment: '해소 proposal 증적 bundle hash (PR1C)' })
  resolutionBundleHash: string | null;
}
