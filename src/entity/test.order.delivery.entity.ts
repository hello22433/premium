import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { OrderProductMappingEntity } from './order.product.mapping.entity';
import { IOrderDeliveryStatus } from '../delivery/interface/order.delivery.status';
import { IOrderSendMethod } from '../order/interface/order.send.method';
import { OrderDeliveryCouponStatus } from '../delivery/interface/order.delivery.coupon.status';

/**
 * 테스트 발송용 주문 배송 엔티티
 * 알림톡 테스트 발송 시 쿠폰 정보 조회를 위해 임시로 저장됨
 */
@Entity('test_order_delivery')
export class TestOrderDeliveryEntity extends BaseEntity {
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

  @Column({ type: 'varchar', length: 256, nullable: true, comment: '전송 바코드 (테스트용 999999)' })
  barCode: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true, comment: '개인번호 (테스트용 999999)' })
  personalCode: string | null;

  @Column({ default: OrderDeliveryCouponStatus.NOT_USED })
  couponStatus: OrderDeliveryCouponStatus;

  @ManyToOne(() => OrderProductMappingEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'order_product_mapping_id' })
  orderProductMapping: OrderProductMappingEntity;
}
