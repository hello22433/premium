import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { EarlyDestroyRequestEntity } from './early.destroy.request.entity';
import { OrderProductMappingEntity } from './order.product.mapping.entity';

@Entity('early_destroy_request_item')
export class EarlyDestroyRequestItemEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ comment: 'FK) early_destroy_request.id' })
  earlyDestroyRequestId: number;

  @Index()
  @Column({ comment: 'FK) order_product_mapping.id' })
  orderProductMappingId: number;

  @ManyToOne(() => EarlyDestroyRequestEntity, (request) => request.items, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'early_destroy_request_id' })
  earlyDestroyRequest: EarlyDestroyRequestEntity;

  @ManyToOne(() => OrderProductMappingEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'order_product_mapping_id' })
  orderProductMapping: OrderProductMappingEntity;
}
