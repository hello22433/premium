import { BaseEntity } from '../common/entity/base.entity';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('event')
export class EventEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 20, comment: '코드' })
  code: string;

  @Column({ type: 'varchar', length: 20, comment: '이름' })
  name: string;

  @Column({ comment: '기간' })
  endAt: Date;
}
