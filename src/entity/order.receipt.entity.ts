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
    comment: '상태 ex) 접수: RECEIVED, 확인중: REVIEWING, 승인: APPROVED, 반려: REJECTED',
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

  @Column({ type: 'text', nullable: true, comment: '요청사항 (기업관리자 작성)' })
  requestNote: string | null;

  @Column({ type: 'text', nullable: true, comment: '확인사항 (운영관리자 작성)' })
  confirmNote: string | null;

  @Column({ comment: '등록 일' })
  registerAt: Date;

  @Column({ type: 'datetime', nullable: true, comment: '승인/반려 처리 일' })
  processedAt: Date | null;

  @Column({ nullable: true, comment: 'FK) user.id, 승인/반려 처리자 id' })
  processedUserId: number | null;

  // ────────────────────────────────────────────────────────────
  // 표시값 스냅샷 (접수/처리 시점 고정)
  // 계정관리에서 담당자가 교체돼 person_name 이 바뀌면 과거 접수 이력의 담당자까지
  // 소급으로 바뀜 보이는 것을 막는다(주문·QnA 와 동일 정책).
  // snapshotPersonName 이 있으면 스냅샷 도입 후 행으로 보고 회사명 NULL 도 당시 값으로 유지한다.
  // snapshotPersonName 이 NULL 인 레거시 행만 user FK join 값으로 fallback 한다.
  // ────────────────────────────────────────────────────────────

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '[snapshot] 접수 등록 시점 담당자명' })
  snapshotPersonName: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '[snapshot] 접수 등록 시점 회사명' })
  snapshotBusinessName: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '[snapshot] 승인/반려 처리 시점 처리자명' })
  snapshotProcessedPersonName: string | null;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  user: UserEntity;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  processedUser: UserEntity;
}
