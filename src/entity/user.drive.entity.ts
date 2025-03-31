import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { UserEntity } from './user.entity';
import { IUserDriveStatus } from '../user_drive/interface/user.drive.status';

@Entity('user_drive')
export class UserDriveEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', comment: 'FK) 발신자 user id' })
  senderId: number;

  @Column({ type: 'int', comment: 'FK) 수신자 user id' })
  receiverId: number;

  @Column({ type: 'varchar', length: 256, comment: '제목' })
  title: string;

  @Column({ type: 'text', comment: '내용' })
  content: string;

  @Column({
    type: 'text',
    nullable: true,
    comment: '파일 url path N 개는 , 로 표기',
  })
  filePath: string | null;

  @Column({
    type: 'enum',
    enum: IUserDriveStatus,
    comment: '진행 상태 ex) 등록: REGISTER, 진행: PROGRESS, 완료: COMPLETE',
  })
  status: IUserDriveStatus;

  @Column({ type: 'datetime', comment: '발신일자 ex) yyyy-MM-ddTHH:mm:ss' })
  sendAt: Date;

  @Column({ type: 'datetime', nullable: true, comment: '수신일자 ex) yyyy-MM-ddTHH:mm:ss' })
  receiveAt: Date | null;

  @Column({ type: 'text', nullable: true, comment: '답변 내용' })
  replyContent: string | null;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'sender_id' })
  sender: UserEntity;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'receiver_id' })
  receiver: UserEntity;
}
