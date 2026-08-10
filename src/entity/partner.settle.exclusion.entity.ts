import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { IPartnerSettleExclusionAction } from '../partner_settle/interface/partner.settle.batch.type';

/**
 * 확정 제외/보류 감사 (정본 §5.9 · PR1D · append-only).
 *
 * confirm 의 `excludeItems` 각 항목·hold 해제마다 1 row append.
 * "왜 이 row 가 이번 지급에서 빠졌는가" 를 추적할 수 있다.
 */
@Entity('partner_settle_exclusion')
@Index('idx_exclusion_ledger', ['ledgerId'])
@Index('idx_exclusion_batch', ['batchId'])
export class PartnerSettleExclusionEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', nullable: true, comment: 'confirm 제외 시 batch. hold 해제는 NULL' })
  batchId: number | null;

  @Column({ type: 'int', comment: 'FK) partner_settle_ledger.id' })
  ledgerId: number;

  @Column({ type: 'varchar', length: 16, comment: 'SKIP_ONCE|HOLD|HOLD_RELEASE' })
  action: IPartnerSettleExclusionAction;

  @Column({ type: 'varchar', length: 500 })
  reason: string;

  @Column({ type: 'int' })
  actedBy: number;

  @Column({ type: 'datetime', precision: 6 })
  actedAt: Date;
}
