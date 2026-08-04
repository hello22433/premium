import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { IUserDiscountCategory } from '../user_discount/interface/user.discount.category';
import { IUserDiscountMethod } from '../user_discount/interface/user.discount.method';
import { ICompareCondition } from '../user_discount/interface/compare.condition';
import { IPriceAdjustment } from '../user_discount/interface/price.adjustment';
import { IPartnerDiscountChangeType } from '../partner_settle/interface/partner.discount.change.type';

/**
 * 협력사 정산조건(매입 할인율) 이력.
 *
 * 완전한 append-only 가 아니라 **값 불변 + 구간 종료 메타 갱신** 모델이다.
 * - 불변: scope 필드 · scopeKey · changeType · pricePercent · priceAdjustment · validFrom
 * - 각 1회 갱신 허용: validTo (NULL → 마감 시각), supersededByHistoryId (NULL → 대체 row id)
 *
 * 원장은 이벤트의 occurredAt 이 속한 구간의 pricePercent 를 쓴다. `DELETE` tombstone 구간이
 * occurredAt 을 덮으면 그 scope 는 그 시각 비활성이라 매칭 후보에서 빠지고, 하위 우선순위 scope 로
 * 폴백하거나 무매칭 0% 가 된다.
 *
 * `user_discount` 의 partner scope(partnerCompanyId 有 · userId 無) 만 대상이며, userId 는 복제하지 않는다.
 *
 * DB 가 강제하는 불변식(마이그레이션 `20260803_partner_credit_pr1a_discount_history.sql`):
 * - `UNIQUE(open_key)` — scope 당 활성 open 구간 정확히 1개.
 *   open_key = `CASE WHEN valid_to IS NULL AND superseded_by_history_id IS NULL AND deleted_at IS NULL THEN scope_key END`
 *   (generated STORED 컬럼이라 엔티티에는 매핑하지 않는다)
 * - tombstone 만 값 NULL / 그 외는 값 NOT NULL
 * - validFrom < validTo
 * - 할인율 절대 상한: DISCOUNT 0~100 · ADDITIONAL 0~1000
 */
@Entity('partner_discount_history')
@Index('idx_partner_discount_history_scope', ['scopeKey', 'validFrom'])
@Index('idx_partner_discount_history_partner', ['partnerCompanyId'])
export class PartnerDiscountHistoryEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', comment: 'FK) partner_company.id' })
  partnerCompanyId: number;

  @Column({ type: 'varchar', length: 24, comment: '[scope] 할인 분류 PRODUCT_GROUP|CATEGORY|BRAND' })
  category: IUserDiscountCategory;

  @Column({ type: 'int', nullable: true, comment: '[scope] FK) classification.id' })
  classificationId: number | null;

  @Column({ type: 'varchar', length: 16, comment: '[scope] 할인 방법 SECTION|BULK' })
  method: IUserDiscountMethod;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '[scope] 브랜드' })
  primaryCategory: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '[scope] 상품군' })
  group: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '[scope] 구간' })
  range: string | null;

  @Column({ type: 'varchar', length: 16, comment: '[scope] 비교 조건' })
  compareCondition: ICompareCondition;

  // 마이그레이션과 같은 binary 대조. 기본 대조를 쓰면 canonical key 비교가 case-insensitive 가 되어
  // 서로 다른 scope 가 같은 구간 타임라인으로 합쳐진다.
  @Column({
    type: 'varchar',
    length: 255,
    charset: 'utf8mb4',
    collation: 'utf8mb4_bin',
    comment: 'canonical scopeKey (sk1|...)',
  })
  scopeKey: string;

  @Column({ type: 'varchar', length: 16, comment: 'CREATE|UPDATE|DELETE(tombstone)' })
  changeType: IPartnerDiscountChangeType;

  @Column({ type: 'int', nullable: true, comment: '수수료 (percent). DELETE tombstone 에서만 NULL' })
  pricePercent: number | null;

  @Column({
    type: 'varchar',
    length: 16,
    nullable: true,
    comment: 'DISCOUNT|ADDITIONAL. DELETE tombstone 에서만 NULL',
  })
  priceAdjustment: IPriceAdjustment | null;

  @Column({ type: 'datetime', precision: 6, comment: '적용 시작' })
  validFrom: Date;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: '적용 종료. NULL = open 구간' })
  validTo: Date | null;

  @Column({ type: 'int', nullable: true, comment: 'FK) user.id 등록·변경자' })
  changedBy: number | null;

  @Column({
    type: 'int',
    nullable: true,
    comment: '경계 일치 소급으로 대체된 경우 대체 row id. 활성 timeline 재구성에서 제외',
  })
  supersededByHistoryId: number | null;
}
