import { BaseEntity } from 'src/common/entity/base.entity';
import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { OrderDeliveryEntity } from './order.delivery.entity';
import { UserEntity } from './user.entity';

@Entity('order_history')
export class OrderHistoryEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) order.delivery.id' })
  orderDeliveryId: number;

  @Column({ comment: 'FK) user.id' })
  userId: number;

  @Column({ type: 'text', nullable: true })
  type: string | null;

  @Column({ type: 'text', nullable: true })
  content: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true, comment: '발송 수단 (알림톡/SMS/MMS/이메일)' })
  sendMethod: string | null;

  @Column({ type: 'text', nullable: true })
  beforeChange: string | null;

  @Column({ type: 'text', nullable: true })
  afterChange: string | null;

  @ManyToOne(() => OrderDeliveryEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'order_delivery_id' })
  orderDelivery: OrderDeliveryEntity;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;
}
