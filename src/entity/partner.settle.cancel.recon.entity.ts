import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { IPartnerSettleCancelReconStatus } from '../partner_settle/interface/partner.settle.batch.type';

/**
 * 확정 후 취소 대사 상태 (정본 §5.15.4 · PR1D).
 *
 * ledger 당 1행. confirm/opening 귀속과 **같은 TX** 에서 INSERT.
 * 상태 전이:
 * - `ACTIVE → TERMINATED` (경계 이후 성공 조회 후 자동 탈락)
 * - `ACTIVE → PERMANENT_FAIL` (연속 실패 MAX_RECON_RETRY 초과)
 * - `ACTIVE → INACTIVE` (unconfirm 비활성)
 * - `INACTIVE → ACTIVE` (reconfirm 재활성)
 */
@Entity('partner_settle_cancel_recon')
@Index('idx_cancel_recon_candidate', ['candidateUntil'])
@Index('idx_cancel_recon_status_candidate', ['status', 'candidateUntil'])
export class PartnerSettleCancelReconEntity {
  @PrimaryColumn({ type: 'int', comment: 'FK) partner_settle_ledger.id — 1 ledger 1행' })
  ledgerId: number;

  @Column({ type: 'datetime', precision: 6, comment: '취소 대사 종료 경계' })
  candidateUntil: Date;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  lastReconciledAt: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  lastReconcileError: string | null;

  @Column({ type: 'int', default: 0 })
  retryCount: number;

  @Column({ type: 'varchar', length: 24, default: 'ACTIVE' })
  status: IPartnerSettleCancelReconStatus;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
