import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { ProductEntity } from './product.entity';

@Entity('popular_product')
export class PopularProductEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) product.id' })
  productId: number;

  @Column({ comment: '고유 고객사 수' })
  uniqueCompanyCount: number;

  @Column({ comment: '총 발송 건수' })
  totalQuantity: number;

  @Column({ comment: '순위 (1~4)' })
  rank: number;

  @Column({ type: 'datetime', comment: '집계 기준일' })
  calculatedAt: Date;

  @ManyToOne(() => ProductEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'product_id' })
  product?: ProductEntity;
}