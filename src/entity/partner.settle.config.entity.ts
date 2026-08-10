import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { IPartnerSettleConfigSource } from '../partner_settle/interface/partner.settle.batch.type';

/**
 * 협력사 정산 경계 config (정본 §5.15.3 · PR1D).
 *
 * 협력사당 1행. `nextNormalPeriodEnd` = 최초 허용 NORMAL `periodEnd`.
 * 활성화 게이트(backfill PASSED) 전에는 CAS 갱신 허용, 활성화 후 불변.
 */
@Entity('partner_settle_config')
export class PartnerSettleConfigEntity {
  @PrimaryColumn({ type: 'int', comment: 'FK) partner_company.id' })
  partnerCompanyId: number;

  @Column({ type: 'date', comment: '최초 허용 NORMAL periodEnd' })
  nextNormalPeriodEnd: string;

  @Column({ type: 'varchar', length: 24, comment: 'OPENING_IMPORT|CUTOVER_MANUAL' })
  source: IPartnerSettleConfigSource;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
