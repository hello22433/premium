import { BaseEntity } from '../common/entity/base.entity';
import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { UserEntity } from './user.entity';
import { IQnaStatus } from '../qna/interface/qna.status';

@Entity('qna')
export class QnaEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) user.id, 등록한 고객사 user id' })
  userId: number;

  @Column({ type: 'varchar', length: 50, comment: '제목' })
  title: string;

  @Column({ type: 'varchar', length: 200, comment: '내용' })
  content: string;

  @Column({ type: 'varchar', nullable: true, comment: '답변 내용' })
  answer: string | null;

  @Column({ type: 'date', comment: '등록일(kst)' })
  registerDate: Date;

  @Column({
    type: 'enum',
    enum: IQnaStatus,
    comment: '상태 ex) WAIT: 대기, OK: 답변완료',
  })
  status: IQnaStatus;

  @Column({
    type: 'text',
    nullable: true,
    comment: '파일 url path N 개는 , 로 표기',
  })
  filePath: string | null;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  user: UserEntity;
}
