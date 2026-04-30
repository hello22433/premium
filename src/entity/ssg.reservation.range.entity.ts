import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';

@Entity('ssg_reservation_range')
export class SsgReservationRangeEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'date', comment: 'SSG 예약발송 가능 시작일' })
  startDate: Date;

  @Column({ type: 'date', comment: 'SSG 예약발송 가능 종료일' })
  endDate: Date;

  @Column({ type: 'int', nullable: true, comment: '최종 수정자 user id' })
  updatedBy: number | null;
}
