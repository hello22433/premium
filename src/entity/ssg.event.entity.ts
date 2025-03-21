import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';

@Entity('ssg_event')
export class SsgEventEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 20, comment: '행사 코드' })
  code: string;

  @Column({ type: 'varchar', length: 20, comment: '행사 번호' })
  no: string;

  @Column({ default: 1, comment: '행사 순번' })
  order: number;

  @Column({ type: 'varchar', length: 20, comment: '행사 명' })
  name: string;

  @Column({ comment: '행사 시작 기간' })
  startAt: Date;

  @Column({ comment: '행사 마감 기간' })
  endAt: Date;

  @Column({ comment: '쿠폰 유효기간(일)' })
  couponExpiration: number;

  @Column({ comment: '행사 금액' })
  eventPrice: number;

  @Column({ default: 0, comment: '행사 잔액' })
  eventBalance: number;
}
