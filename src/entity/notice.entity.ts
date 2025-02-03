import { BaseEntity } from '../common/entity/base.entity';
import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { UserEntity } from './user.entity';
import { NoticePriority } from '../notice/interface/notice.priority';

@Entity('notice')
export class NoticeEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) user.id, 등록한 관리자 id' })
  userId: number;

  @Column({ type: 'varchar', length: 50, comment: '제목' })
  title: string;

  @Column({ type: 'varchar', length: 200, comment: '내용' })
  content: string;

  @Column({ type: 'varchar', length: 100, comment: '중요도 ex) 상: HIGH, 중: MEDIUM, 하: LOW' })
  priority: NoticePriority;

  @Column({ comment: '등록 일' })
  registerAt: Date;

  @Column({
    type: 'text',
    nullable: true,
    comment: '파일 url path N 개는 , 로 표기',
  })
  filePath: string | null;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  user: UserEntity;
}
