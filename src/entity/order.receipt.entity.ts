import { BaseEntity } from '../common/entity/base.entity';
import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { UserEntity } from './user.entity';
import { OrderReceiptStatus } from '../order_receipt/interface/order.receipt.status';

@Entity('order_receipt')
export class OrderReceiptEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) user.id, 등록한 사용자 id' })
  userId: number;

  @Column({ type: 'varchar', length: 100, comment: '제목' })
  title: string;

  @Column({
    type: 'varchar',
    length: 50,
    comment: '상태 ex) 접수: RECEIVED, 승인: APPROVED, 반려: REJECTED',
  })
  status: OrderReceiptStatus;

  @Column({
    type: 'text',
    nullable: true,
    comment: '파일 url path N 개는 , 로 표기',
  })
  filePath: string | null;

  @Column({
    type: 'varchar',
    nullable: true,
    length: 200,
    comment: '반려 사유',
  })
  rejectReason: string | null;

  @Column({
    type: 'text',
    nullable: true,
    comment: '확인사항 메모 (운영관리자 기재)',
  })
  memo: string | null;

  @Column({ comment: '등록 일' })
  registerAt: Date;

  @Column({ type: 'datetime', nullable: true, comment: '승인/반려 처리 일' })
  processedAt: Date | null;

  @Column({ nullable: true, comment: 'FK) user.id, 승인/반려 처리자 id' })
  processedUserId: number | null;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  user: UserEntity;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  processedUser: UserEntity;
}