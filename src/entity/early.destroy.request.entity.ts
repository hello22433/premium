import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { OrderEntity } from './order.entity';
import { UserEntity } from './user.entity';
import { EarlyDestroyRequestItemEntity } from './early.destroy.request.item.entity';

export enum EarlyDestroyRequestStatus {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

@Entity('early_destroy_request')
export class EarlyDestroyRequestEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) order.id' })
  orderId: number;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '고객사명' })
  clientCompany: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '담당자명' })
  contactPerson: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, comment: '담당자 이메일' })
  contactEmail: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '판매전표 번호' })
  salesReceipt: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, comment: '이벤트명' })
  eventName: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, comment: '품목/수량 정보' })
  productInfo: string | null;

  @Column({ type: 'text', nullable: true, comment: '특이사항' })
  specialNotes: string | null;

  @Column({ type: 'datetime', nullable: true, comment: '완료 희망일시' })
  desiredCompletionDate: Date | null;

  @Column({ type: 'text', nullable: true, comment: '참고사항' })
  referenceNotes: string | null;

  @Column({ type: 'enum', enum: EarlyDestroyRequestStatus, default: EarlyDestroyRequestStatus.PENDING, comment: '요청 상태' })
  status: EarlyDestroyRequestStatus;

  @Column({ comment: '요청자 FK) user.id' })
  requestedBy: number;

  @Column({ comment: '요청 일시' })
  requestedAt: Date;

  @Column({ type: 'int', nullable: true, comment: '파기 실행자 FK) user.id' })
  executedBy: number | null;

  @Column({ type: 'datetime', nullable: true, comment: '파기 실행 일시' })
  executedAt: Date | null;

  @ManyToOne(() => OrderEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'order_id' })
  order: OrderEntity;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'requested_by' })
  requestedByUser: UserEntity;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'executed_by' })
  executedByUser: UserEntity;

  @OneToMany(() => EarlyDestroyRequestItemEntity, (item) => item.earlyDestroyRequest)
  items: EarlyDestroyRequestItemEntity[];
}
