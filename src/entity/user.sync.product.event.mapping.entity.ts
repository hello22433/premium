import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { UserSyncProductEventEntity } from './user.sync.product.event.entity';
import { ProductEntity } from './product.entity';

@Entity('user_sync_product_event_mapping')
export class UserSyncProductEventMappingEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) 연동 이벤트 event.id' })
  userSyncProductEventId: number;

  @Column({ comment: 'FK) 상품 product.id' })
  productId: number;

  @ManyToOne(() => UserSyncProductEventEntity)
  @JoinColumn({ name: 'user_sync_product_event_id' })
  userSyncProductEvent: UserSyncProductEventEntity;

  @ManyToOne(() => ProductEntity)
  @JoinColumn({ name: 'product_id' })
  product: ProductEntity;
}
