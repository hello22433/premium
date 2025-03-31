import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { UserEntity } from './user.entity';
import { ProductEntity } from './product.entity';

@Entity('product_like')
export class ProductLikeEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', comment: 'user ID' })
  userId: number;

  @Column({ type: 'int', comment: 'FK) product id' })
  productId: number;

  @Column({ comment: '찜 여부' })
  isLike: boolean;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @ManyToOne(() => ProductEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'product_id' })
  product: ProductEntity;
}
