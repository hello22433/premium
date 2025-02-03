import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { OrderEntity } from './order.entity';
import { ProductEntity } from './product.entity';
import { BaseEntity } from '../common/entity/base.entity';
import { OrderDeliveryEntity } from './order.delivery.entity';

@Entity('order_product_mapping')
export class OrderProductMappingEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) order.id' })
  orderId: number;

  @Column({ comment: 'FK) product.id' })
  productId: number;

  @Column({ comment: '상품 개수' })
  amount: number;

  @ManyToOne(() => OrderEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'order_id' })
  order: OrderEntity;

  @ManyToOne(() => ProductEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'product_id' })
  product: ProductEntity;

  @OneToMany(() => OrderDeliveryEntity, (orderDelivery) => orderDelivery.orderProductMapping, {
    createForeignKeyConstraints: false,
  })
  orderDeliveries: OrderDeliveryEntity[];
}
