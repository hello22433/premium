import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { IOrderStatus } from '../order/interface/order.status';
import { UserEntity } from './user.entity';
import { OrderProductMappingEntity } from './order.product.mapping.entity';
import { BaseEntity } from '../common/entity/base.entity';
import { IOrderType } from '../order/interface/order.type';
import { OrderLikeEntity } from './order.like.entity';
import { SettleUserOrderDetailEnum } from '../settle/interface/settle.user.order.detail';

@Entity('order')
export class OrderEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ comment: 'FK) user.id' })
  userId: number;

  @Column({ nullable: true, comment: '운영 담당자 FK) user.id' })
  operationUserId: number | null;

  @Index()
  @Column({ nullable: true, comment: '과금 대상 담당자 FK) user.id (대행주문 시 사용)' })
  clientUserId: number | null;

  @Column({ type: 'varchar', length: 256, unique: true, comment: 'event 코드' })
  code: string;

  @Index()
  @Column({ comment: '진행 상태' })
  status: IOrderStatus;

  @Column({ comment: '타입 ex) 일반: GENERAL, 신세계: SSG , 맞춤형, 실물' })
  type: IOrderType;

  @Column({ type: 'varchar', length: 100, comment: '이벤트 명' })
  eventName: string;

  @Column({ comment: ' 등록일' })
  registerAt: Date;

  @Column({ default: 0, comment: '발송 금액' })
  sendAmount: number;

  @Column({ default: 0, comment: '정산 금액' })
  settleAmount: number;

  @Column({ default: 0, comment: '배송 완료 리포트 pdf 카운트' })
  deliveryCompleteReportCount: number;

  @Column({
    type: 'varchar',
    length: 20,
    nullable: true,
    comment: '마지막 배송 완료 리포트 발행 소스 ex) DOCUMENT: 문서함, DIRECT: 직접발행',
  })
  deliveryReportLastSource: string | null;

  @Column({ default: 0, comment: '거래명세서 pdf 카운트' })
  orderCompleteReportCount: number;

  @Column({
    type: 'varchar',
    length: 20,
    nullable: true,
    comment: '마지막 거래명세서 발행 소스 ex) DOCUMENT: 문서함, DIRECT: 직접발행',
  })
  transactionStatementLastSource: string | null;

  @Column({ type: 'int', nullable: true, comment: 'FK) ssg_event.id for SSG orders' })
  ssgEventId: number | null;

  @Column({ type: 'enum', enum: SettleUserOrderDetailEnum, nullable: true, comment: '정산상태 ' })
  settleStatus: SettleUserOrderDetailEnum | null;

  @Column({ default: false, comment: '정산 확정 여부' })
  isSettleComplete: boolean;

  @Column({ default: false, comment: '정산 선충전 혹은 한도 여부' })
  isSettleBalance: boolean;

  @Column({ default: true, comment: '신규 과금 흐름 적용 여부 (true: 발송확정 시 차감)' })
  isNewBillingFlow: boolean;

  @Column({ default: false, comment: '카드할증 적용 여부 (3%)' })
  cardSurchargeApplied: boolean;

  @Column({ default: false, comment: '신용초과발송 여부' })
  isCreditExcess: boolean;

  @Column({ type: 'text', nullable: true, comment: '주문 취소 사유' })
  cancelReason: string | null;

  @Column({ type: 'datetime', nullable: true, comment: '주문 취소 일시' })
  canceledAt: Date | null;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'operation_user_id' })
  operationUser?: UserEntity;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'client_user_id' })
  clientUser?: UserEntity;

  @OneToMany(() => OrderProductMappingEntity, (orderProductMapping) => orderProductMapping.order, {
    createForeignKeyConstraints: false,
  })
  orderProductMappings?: OrderProductMappingEntity[];

  @OneToMany(() => OrderLikeEntity, (orderLike) => orderLike.order, {
    createForeignKeyConstraints: false,
  })
  orderLikes?: OrderLikeEntity[];
}
