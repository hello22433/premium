import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { IUserDiscountCategory } from '../user_discount/interface/user.discount.category';
import { IPriceAdjustment } from '../user_discount/interface/price.adjustment';
import { ICompareCondition } from '../user_discount/interface/compare.condition';
import { IUserDiscountMethod } from '../user_discount/interface/user.discount.method';
import { UserEntity } from './user.entity';
import { PartnerCompanyEntity } from './partner.company.entity';
import { ClassificationEntity } from './classification.entity';
import { BaseEntity } from '../common/entity/base.entity';

@Entity('user_discount')
@Index('idx_user_discount_user', ['userId'])
@Index('idx_user_discount_partner', ['partnerCompanyId'])
export class UserDiscountEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) user.id ', nullable: true, type: 'int' })
  userId: number | null;

  @Column({ comment: 'FK) partnerCompany.id ', nullable: true, type: 'int' })
  partnerCompanyId: number | null;

  @Column({
    type: 'enum',
    enum: IUserDiscountCategory,
    comment: '할인 분류 ex) 상품군: PRODUCT_GROUP, 카테고리: CATEGORY, 브랜드: BRAND',
  })
  category: IUserDiscountCategory;

  @Column({ nullable: true, comment: 'FK) classification.id 카테고리' })
  classificationId: number | null;

  @Column({
    type: 'enum',
    enum: IUserDiscountMethod,
    comment: '할인 방법 ex) 구간: SECTION, 일괄: BULK',
  })
  method: IUserDiscountMethod;

  @Column({ type: 'varchar', nullable: true, length: 100, comment: '브랜드' })
  primaryCategory: string | null;

  @Column({ type: 'varchar', nullable: true, length: 100, comment: '상품군' })
  group: string | null;

  @Column({ type: 'varchar', nullable: true, length: 100, comment: '구간' })
  range: string | null;

  @Column({
    type: 'enum',
    enum: ICompareCondition,
    comment: '비교 조건 ex) MORE_THAN: 초과, MORE: 이상, LESS_THAN: 미만, LESS: 이하',
  })
  compareCondition: ICompareCondition;

  @Column({
    type: 'enum',
    enum: IPriceAdjustment,
    comment: '가격 조정 타입 ex) 할인: DISCOUNT, 할증: ADDITIONAL',
  })
  priceAdjustment: IPriceAdjustment;

  @Column({ comment: '수수료 (percent)' })
  pricePercent: number;

  @ManyToOne(() => ClassificationEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'classification_id' })
  classification: ClassificationEntity;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @ManyToOne(() => PartnerCompanyEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'partner_company_id' })
  partnerCompany: PartnerCompanyEntity;
}
