import { BaseEntity } from '../common/entity/base.entity';
import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { InquiryStatus } from '../inquiry/interface/inquiry.status';
import { UserEntity } from './user.entity';

@Entity('inquiry')
export class InquiryEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) user.id 문의를 한 유저 id' })
  userId: number;

  @Column({ type: 'varchar', length: 50, comment: '진행 상태 ex) 등록: REGISTER, 진행: PROGRESS, 완료: COMPLETE' })
  status: InquiryStatus;

  @Column({
    type: 'text',
    nullable: true,
    comment: '파일 url path N 개는 , 로 표기',
  })
  filePath: string | null;

  @Column({ type: 'varchar', length: 50, comment: '제목' })
  title: string;

  @Column({ type: 'varchar', length: 200, comment: '내용' })
  content: string;

  @Column({
    type: 'varchar',
    nullable: true,
    length: 200,
    comment: '답글 내용',
  })
  replyContent: string | null;

  @ManyToOne(() => UserEntity)
  user: UserEntity;
}
