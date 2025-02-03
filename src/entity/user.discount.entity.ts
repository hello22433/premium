import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('user_discount')
export class UserDiscountEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) user.id ' })
  userId: number;

  @Column({ type: 'varchar', length: 100, comment: '할인 분류' })
  category: string;

  @Column({ type: 'varchar', length: 100, comment: '할인 방법' })
  method: string;

  @Column({ type: 'varchar', nullable: true, length: 100, comment: '대 분류' })
  primaryCategory: string | null;

  @Column({ type: 'varchar', nullable: true, length: 100, comment: '상품 군' })
  group: string | null;

  @Column({ type: 'varchar', nullable: true, length: 100, comment: '구간' })
  range: string | null;

  @Column({ type: 'varchar', length: 100, comment: '비교 조건' })
  compareCondition: string;

  @Column({ type: 'varchar', length: 100, comment: '할인 할증' })
  priceAdjustment: string;

  @Column({ comment: '수수료 (percent)' })
  pricePercent: number;
}
