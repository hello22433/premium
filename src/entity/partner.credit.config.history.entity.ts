import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';

/** 여신 설정 변경 이력의 종류 (정본 §5.4 · 22차 MED). */
export type IPartnerCreditConfigHistoryAction = 'CREATE' | 'UPDATE';

/**
 * 협력사 여신 설정 변경 이력 (정본 §5.4 · append-only).
 *
 * `PUT settle/credit/config` 성공 시 config 갱신과 **같은 트랜잭션**에서 append 한다(3차 M3).
 * `CREATE`(최초 INSERT) 는 이전 값이 없어 `before*` 가 NULL 이고, `after*` 는 CREATE·UPDATE 모두
 * 기록해 이력만으로 최초 설정 금액을 재현할 수 있게 한다(23차 MED).
 */
@Entity('partner_credit_config_history')
@Index('idx_partner_credit_config_history_scope', ['partnerCompanyId', 'subItemKey', 'changedAt'])
export class PartnerCreditConfigHistoryEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  partnerCompanyId: number;

  @Column({ type: 'varchar', length: 32, comment: '하위 없으면 sentinel NONE' })
  subItemKey: string;

  @Column({ type: 'varchar', length: 16, comment: 'CREATE|UPDATE' })
  action: IPartnerCreditConfigHistoryAction;

  @Column({ type: 'bigint', nullable: true, comment: '변경 이전 스냅샷. CREATE 는 NULL' })
  beforeInsuranceAmount: string | null;

  @Column({ type: 'bigint', nullable: true })
  beforePrepaidAmount: string | null;

  @Column({ type: 'bigint', nullable: true })
  beforeEtcAmount: string | null;

  @Column({ type: 'bigint', comment: '변경/생성 후 스냅샷' })
  afterInsuranceAmount: string;

  @Column({ type: 'bigint' })
  afterPrepaidAmount: string;

  @Column({ type: 'bigint' })
  afterEtcAmount: string;

  @Column({ type: 'int', comment: 'FK) user.id — 수정자' })
  changedBy: number;

  @Column({ type: 'datetime', precision: 6, comment: 'KST naive' })
  changedAt: Date;
}
