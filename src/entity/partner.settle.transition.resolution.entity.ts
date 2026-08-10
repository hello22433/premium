import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';

export type ITransitionResolutionStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/**
 * 미복원 전이 해소 propose→approve (정본 §5.15.1).
 * UNRESOLVED observation의 전이 사슬을 운영자가 확인 후 승인하면 ledger event를 append한다.
 */
@Entity('partner_settle_transition_resolution')
@Index('idx_transition_resolution_observation', ['observationId'])
export class PartnerSettleTransitionResolutionEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', comment: 'FK) partner_settle_transition_observation.id' })
  observationId: number;

  @Column({ type: 'json', comment: '[{prev,new,sourceEventIdOrigin,sourceEventId?,…}]' })
  proposedTransitions: Array<Record<string, unknown>>;

  @Column({ type: 'varchar', length: 128, comment: 'sequenceNo 오름차순 {sequenceNo, providerEvidenceHash} 배열 hash' })
  resolutionBundleHash: string;

  @Column({ type: 'varchar', length: 255, comment: '멱등 키 (UNIQUE)' })
  requestKey: string;

  @Column({ type: 'varchar', length: 128 })
  payloadHash: string;

  @Column({ type: 'varchar', length: 8, default: 'v1' })
  payloadHashVersion: string;

  @Column({ type: 'varchar', length: 16, comment: 'PENDING|APPROVED|REJECTED' })
  status: ITransitionResolutionStatus;

  @Column({ type: 'int' })
  proposedBy: number;

  @Column({ type: 'int', nullable: true, comment: 'CHECK(decided_by != proposed_by)' })
  decidedBy: number | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  decidedAt: Date | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  decisionReason: string | null;

  // active_pending_key: DB generated — 관측당 활성 PENDING 1건
}
