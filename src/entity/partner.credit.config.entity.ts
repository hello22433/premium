import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';

/**
 * 협력사 여신 설정 (정본 §5.3).
 *
 * (협력사, 하위항목) 단위로 보증보험/선입금/기타 금액을 보관한다. 월 한도는 **저장하지 않고**
 * 협력사 타입별 공식으로 계산한다(`credit.monthly.limit.ts`).
 *
 * - `subItemKey` 는 NOT NULL sentinel `'NONE'`(`SUB_ITEM_KEY_NONE`) 으로 통일한다 — MySQL unique index 는
 *   NULL 을 서로 다른 값으로 취급해 하위 없는 협력사를 NULL 로 두면 UNIQUE 가 무력화된다(§5.3).
 * - `version` 은 optimistic lock 이다. PUT 이 `expectedVersion` 불일치를 409 로 거부한다(3차 M3).
 * - 금액은 전부 `bigint`(원 단위 정수). API 는 canonical 정수 문자열로 직렬화한다(§5 금액 계약).
 */
@Entity('partner_credit_config')
@Unique('uk_partner_credit_config_scope', ['partnerCompanyId', 'subItemKey'])
export class PartnerCreditConfigEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', comment: 'FK) partner_company.id' })
  partnerCompanyId: number;

  @Column({ type: 'varchar', length: 32, comment: '하위항목 키. 하위 없으면 sentinel NONE' })
  subItemKey: string;

  @Column({ type: 'bigint', comment: '보증보험 (원 단위 정수)' })
  insuranceAmount: string;

  @Column({ type: 'bigint', comment: '선입금' })
  prepaidAmount: string;

  @Column({ type: 'bigint', comment: '기타' })
  etcAmount: string;

  @Column({ type: 'int', default: 0, comment: 'optimistic lock. 갱신마다 +1' })
  version: number;
}
