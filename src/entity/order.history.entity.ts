import { BaseEntity } from "src/common/entity/base.entity";
import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";

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

  @Column({ type: 'text', nullable: true })
  beforeChange: string | null;

  @Column({ type: 'text', nullable: true })
  afterChange: string | null;
}
