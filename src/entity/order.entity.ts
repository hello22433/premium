import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { IOrderStatus } from '../order/interface/order.status';
import { UserEntity } from './user.entity';
import { OrderProductMappingEntity } from './order.product.mapping.entity';
import { BaseEntity } from '../common/entity/base.entity';
import { IOrderSendMethod } from '../order/interface/order.send.method';
import { IOrderType } from '../order/interface/order.type';
import { OrderEmailSendType } from '../order/domain/order.email.send.type';
import { OrderLikeEntity } from './order.like.entity';

@Entity('order')
export class OrderEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) user.id' })
  userId: number;

  @Column({ nullable: true, comment: '운영 담당자 FK) user.id' })
  operationUserId: number | null;

  @Column({ type: 'varchar', length: 256, unique: true, comment: 'event 코드' })
  code: string;

  @Column({ comment: '진행 상태' })
  status: IOrderStatus;

  @Column({ comment: '타입 ex) 일반: GENERAL, 신세계: SSG , 맞춤형, 실물' })
  type: IOrderType;

  @Column({ type: 'varchar', length: 100, comment: '이벤트 명' })
  eventName: string;

  @Column({ type: 'varchar', length: 100, comment: '발신 수단 ex) ALIM_TAK : 알림톡, SMS : SMS, EMAIL : email' })
  sendMethod: IOrderSendMethod;

  @Column({
    type: 'varchar',
    length: 100,
    nullable: true,
    comment: '꼬리 광고 text',
  })
  sendTailText: string | null;

  @Column({
    comment: '개인정보파기 요청일',
  })
  requestToDestroyPersonalInfoDay: number;

  @Column({ type: 'varchar', nullable: true, length: 20, comment: '발신 번호' })
  fromPhoneNumber: string | null;

  @Column({ type: 'varchar', length: 20, comment: '발신 제목' })
  sendTitle: string;

  @Column({ type: 'varchar', length: 200, comment: '발신 내용' })
  sendContent: string;

  @Column({ type: 'varchar', nullable: true, length: 100, comment: '발신 이메일' })
  fromEmail: string | null;

  @Column({ type: 'varchar', nullable: true, length: 100, comment: 'QR: QR, URL: URL' })
  emailSendType: OrderEmailSendType | null;

  @Column({ type: 'text', nullable: true, comment: '이메일 시 사용 방법' })
  useEmailContent: string | null;

  @Column({ comment: ' 등록일' })
  registerAt: Date;

  @Column({ default: 0, comment: '발송 금액' })
  sendAmount: number;

  @Column({ default: 0, comment: '정산 금액' })
  settleAmount: number;

  @Column({ default: 0, comment: '배송 완료 리포트 pdf 카운트' })
  deliveryCompleteReportCount: number;

  @Column({ default: 0, comment: '거래명세서 pdf 카운트' })
  orderCompleteReportCount: number;

  // 전송 시간 조회 편의성을 위한 컬럼 추가
  @Column({ comment: '발송 요청 시각' })
  sendRequestAt: Date;

  @Column({ name: 'send_type', type: 'varchar', length: 50, nullable: true })
  sendType: string | null;

  @Column({ type: 'int', nullable: true, comment: 'FK) ssg_event.id for SSG orders' })
  ssgEventId: number | null;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'operation_user_id' })
  operationUser?: UserEntity;

  @OneToMany(() => OrderProductMappingEntity, (orderProductMapping) => orderProductMapping.order, {
    createForeignKeyConstraints: false,
  })
  orderProductMappings?: OrderProductMappingEntity[];

  @OneToMany(() => OrderLikeEntity, (orderLike) => orderLike.order, {
    createForeignKeyConstraints: false,
  })
  orderLikes?: OrderLikeEntity[];
}
