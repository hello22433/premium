import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { OrderProductMappingEntity } from './order.product.mapping.entity';
import { IOrderDeliveryStatus } from '../delivery/interface/order.delivery.status';
import { IOrderSendMethod } from '../order/interface/order.send.method';
import { SsgEventEntity } from './ssg.event.entity';
import { OrderDeliveryCouponStatus } from '../delivery/interface/order.delivery.coupon.status';
import { OrderDeliveryEmailCouponStatus } from '../delivery/interface/order.delivery.email.coupon.status';
import { ProductEntity } from './product.entity';
import { OrderHistoryEntity } from './order.history.entity';

@Entity('order_delivery')
export class OrderDeliveryEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: '전송 상태' })
  status: IOrderDeliveryStatus;

  @Column({ comment: 'FK) order_product_mapping.id' })
  orderProductMappingId: number;

  @Column({ comment: '전달 방식 ex) EMAIL, SMS, ALIM_TALK' })
  deliveryMethod: IOrderSendMethod;

  @Column({ type: 'varchar', length: 128, comment: 'EMAIL 일 경우 email, SMS, ALIM_TALK 일 경우 핸드폰 번호' })
  deliveryTarget: string;

  @Column({ type: 'varchar', length: 512, nullable: true, comment: '이미지 경로' })
  imagePath: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, comment: '대치문자 1' })
  replaceCharacter1: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, comment: '대치문자 2' })
  replaceCharacter2: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, comment: '대치문자 3' })
  replaceCharacter3: string | null;

  @Column({ comment: '발송 요청 시각' })
  sendRequestAt: Date;

  @Column({ type: 'datetime', nullable: true, comment: '만료 시간' })
  expireAt: Date | null;

  @Column({ type: 'varchar', length: 256, nullable: true, comment: '트랜잭션 id' })
  transactionId: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true, comment: '전송 바코드' })
  barCode: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true, comment: '개인번호 for ssg' })
  personalCode: string | null;

  @Column({ type: 'int', nullable: true, comment: 'FK) ssg_event.id' })
  ssgEventId: number | null;

  @Column({ default: OrderDeliveryCouponStatus.NOT_USED })
  couponStatus: OrderDeliveryCouponStatus;

  @Column({ type: 'varchar', length: 100, nullable: true })
  emailCouponStatus: OrderDeliveryEmailCouponStatus | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  ssgTransactionId: string | null;

  @Column({ type: 'int', nullable: true, comment: 'FK) product.id 초이스 쿠폰 시' })
  choiceSelectProductId: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '기타 외부 협력사 코드 정보' })
  couponNum: string | null;

  @Column({ type: 'datetime', nullable: true, comment: '교환시각' })
  tradeAt: Date | null;

  @Column({ default: 0, comment: '갤럭시아 상품권형 잔액' })
  galaxiaBalance: number;

  @ManyToOne(() => OrderProductMappingEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'order_product_mapping_id' })
  orderProductMapping: OrderProductMappingEntity;

  @ManyToOne(() => SsgEventEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'ssg_event_id' })
  ssgEvent?: SsgEventEntity;

  @ManyToOne(() => ProductEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'choice_select_product_id' })
  choiceSelectProduct?: ProductEntity;

  @OneToMany(() => OrderHistoryEntity, (history) => history.orderDelivery)
  orderHistory: OrderHistoryEntity[];

  @Column({ type: 'varchar', length: 256, nullable: true })
  apiErrorMessage: string | null;
}
