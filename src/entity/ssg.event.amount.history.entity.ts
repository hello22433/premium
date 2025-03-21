import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';

@Entity('ssg_event_amount_history')
export class SsgEventAmountHistoryEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', nullable: true, comment: 'FK) ssg event id' })
  ssgEventId: number | null;

  @Column({ type: 'int', nullable: true, comment: '사용 또는 충전 금액' })
  amount: number | null;

  @Column({ type: 'int', default: 0, comment: '신세계 잔액' })
  balance: number;

  @Column({ type: 'int', nullable: true, comment: 'FK) order id' })
  orderId: number | null;
}
