import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { OrderEntity } from './order.entity';
import { ProductEntity } from './product.entity';
import { BaseEntity } from '../common/entity/base.entity';
import { OrderDeliveryEntity } from './order.delivery.entity';
import { IOrderSettleDiscountType } from '../order/interface/order.settle.discount.type';
import { IPriceAdjustment } from '../user_discount/interface/price.adjustment';

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

  @Column({ comment: '상품 미리보기 상단 이미지 url' })
  topImagePath: string;

  @Column({ comment: '상품 미리보기 중간 이미지 url' })
  midImagePath: string;

  @Column({
    type: 'enum',
    enum: IOrderSettleDiscountType,
    nullable: true,
    comment: '정산 시 사용되는 할인 구분 ex) 단건: ONE, 계약: CONTRACT ',
  })
  settleDiscountType: IOrderSettleDiscountType | null;

  @Column({
    type: 'enum',
    enum: IPriceAdjustment,
    nullable: true,
    comment: '정산 시 사용되는 할인 방법 ex) 할인: DISCOUNT, 할증: ADDITIONAL ',
  })
  priceAdjustment: IPriceAdjustment | null;

  @Column({
    type: 'int',
    nullable: true,
    comment: '정산 시 사용되는 수수료 (percent) ',
  })
  fee: number | null;

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
