import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { OrderEntity } from './order.entity';
import { UserEntity } from './user.entity';

@Entity('order_like')
export class OrderLikeEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', comment: 'user ID' })
  userId: number;

  @Column({ type: 'int', comment: 'order pk' })
  orderId: number;

  @Column({ comment: '찜 여부' })
  isLike: boolean;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  user: UserEntity;

  @ManyToOne(() => OrderEntity, { createForeignKeyConstraints: false })
  order: OrderEntity;
}
