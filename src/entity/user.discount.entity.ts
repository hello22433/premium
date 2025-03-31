import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { IUserDiscountCategory } from '../user_discount/interface/user.discount.category';
import { IPriceAdjustment } from '../user_discount/interface/price.adjustment';
import { ICompareCondition } from '../user_discount/interface/compare.condition';
import { IUserDiscountMethod } from '../user_discount/interface/user.discount.method';
import { UserEntity } from './user.entity';

@Entity('user_discount')
export class UserDiscountEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) user.id ', nullable: true, type: 'int' })
  userId: number | null;

  @Column({ comment: 'FK) partnerCompany.id ', nullable: true, type: 'int' })
  partnerCompanyId: number | null;

  @Column({
    type: 'enum',
    enum: IUserDiscountCategory,
    comment: '할인 분류 ex) 상품군: CATEGORY, 대분류: CLASSIFICATION',
  })
  category: IUserDiscountCategory;

  @Column({
    type: 'enum',
    enum: IUserDiscountMethod,
    comment: '할인 방법 ex) 구간: SECTION, 일괄: BULK',
  })
  method: IUserDiscountMethod;

  @Column({ type: 'varchar', nullable: true, length: 100, comment: '대분류' })
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

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;
}
