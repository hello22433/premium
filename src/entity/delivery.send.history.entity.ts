import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { IOrderSendMethod } from '../order/interface/order.send.method';

@Entity('delivery_send_history')
export class DeliverySendHistoryEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 128, comment: '전송 대상자' })
  target: string;

  @Column({ type: 'text', comment: '전송 내역 history' })
  context: string;

  @Column({ type: 'text', nullable: true, comment: '전송 내역 history 기타' })
  etcContext: string | null;

  @Column({ comment: '성공 여부 ' })
  isSuccess: boolean;

  @Column({ comment: '전달 방식 ex) EMAIL, SMS, ALIM_TALK' })
  deliveryMethod: IOrderSendMethod;
}
