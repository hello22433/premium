import { BaseEntity } from '../common/entity/base.entity';
import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { ProductEntity } from './product.entity';

@Entity('product_choice_mapping')
export class ProductChoiceMappingEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) choice_product_id, type이 CHOICE인 상품' })
  choiceProductId: number;

  @Column({ comment: 'FK) 일반 상품 ID' })
  productId: number;

  @ManyToOne(() => ProductEntity, {
    createForeignKeyConstraints: false,
  })
  @JoinColumn({ name: 'choice_product_id' })
  choiceProduct: ProductEntity;

  @ManyToOne(() => ProductEntity, {
    createForeignKeyConstraints: false,
  })
  @JoinColumn({ name: 'product_id' })
  product: ProductEntity;
}
