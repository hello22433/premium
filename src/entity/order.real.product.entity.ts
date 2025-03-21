import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { UserEntity } from './user.entity';
import { OrderRealProductMappingEntity } from './order.real.product.mapping.entity';
import { IOrderRealProductStatus } from '../order_real_product/interface/order.real.product.status';

@Entity('order_real_product')
export class OrderRealProductEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) 등록한 담당자 user.id' })
  userId: number;

  @Column({ nullable: true, comment: 'FK) 고객사 user id ' })
  businessUserId: number;

  @Column({ type: 'varchar', length: 100, comment: '이벤트 명' })
  eventName: string;

  @Column({ type: 'datetime', nullable: true, comment: '최종 완료 시간 ex) yyyy-MM-ddTHH:mm:ss' })
  finishedAt: Date | null;

  @Column({
    type: 'enum',
    enum: IOrderRealProductStatus,
    comment:
      '상태 ex) ' +
      'ORDER_PENDING 확정 대기' +
      'ORDER_CONFIRM = 주문 확정' +
      'ORDER_COMPLETED =  발주 완료' +
      'STORAGE_COMPLETED = 입고 완료' +
      'DELIVERY_PROGRESS =  배송중' +
      'DELIVERY_COMPLETED = 배송 완료' +
      'ORDER_CANCELED = 주문 취소' +
      'ORDER_EDIT_REQUEST = 주문 수정 요청',
  })
  status: IOrderRealProductStatus;

  // 고객사 user
  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'business_user_id' })
  businessUser: UserEntity;

  // 담당자 user
  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @OneToMany(
    () => OrderRealProductMappingEntity,
    (orderRealProductMapping) => orderRealProductMapping.realProductOrder,
    {
      createForeignKeyConstraints: false,
    },
  )
  orderRealProductMappings: OrderRealProductMappingEntity[];
}
