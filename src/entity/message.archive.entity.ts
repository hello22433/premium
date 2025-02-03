import { BaseEntity } from '../common/entity/base.entity';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('message_archive')
export class MessageArchiveEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) user.id, 해당 문자를 저장한 유저' })
  userId: number;

  @Column({ type: 'varchar', length: 20, comment: '제목' })
  title: string;

  @Column({ type: 'varchar', length: 200, comment: '내용' })
  content: string;
}
