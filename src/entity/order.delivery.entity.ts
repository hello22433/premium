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
import { OrderDeliveryRefundStatusEnum } from '../delivery/interface/order.delivery.refund.status.enum';
import { IPriceAdjustment } from '../user_discount/interface/price.adjustment';
import { IOrderSettleDiscountType } from '../order/interface/order.settle.discount.type';

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

  @Column({ type: 'varchar', length: 128, nullable: true, comment: '최초 발송 수신정보 (암호화, CS 변경 시에도 불변)' })
  originalDeliveryTarget: string | null;

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

  @Column({ type: 'datetime', nullable: true, comment: '실제 발송 시각' })
  actualSendAt: Date | null;

  @Column({ type: 'datetime', nullable: true, comment: '만료 시간' })
  expireAt: Date | null;

  @Column({ type: 'varchar', length: 256, nullable: true, comment: '트랜잭션 id' })
  transactionId: string | null;

  @Column({ type: 'varchar', length: 26, nullable: true, comment: '외부 API 트랜잭션 ID (ULID)' })
  externalTrId: string | null;

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

  @Column({ type: 'varchar', length: 512, nullable: true, comment: '이메일 쿠폰 수령 시 입력한 핸드폰 번호 (암호화)' })
  emailReceiverPhone: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  ssgTransactionId: string | null;

  @Column({ type: 'int', nullable: true, comment: 'FK) product.id 초이스 쿠폰 시' })
  choiceSelectProductId: number | null;

  @Column({ type: 'datetime', nullable: true, comment: '실제 쿠폰 발급 일시 (초이스 선택/이메일 전화번호 입력 시점)' })
  couponIssuedAt: Date | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '기타 외부 협력사 코드 정보' })
  couponNum: string | null;

  @Column({ type: 'datetime', nullable: true, comment: '교환시각' })
  tradeAt: Date | null;

  @Column({ type: 'varchar', length: 200, nullable: true, comment: '교환장소' })
  tradePlace: string | null;

  @Column({ default: 0, comment: '갤럭시아 상품권형 잔액' })
  galaxiaBalance: number;

  @Column({ type: 'datetime', nullable: true, comment: '독려 문자 일시' })
  encourageAt: Date | null;

  @Column({ type: 'datetime', nullable: true, comment: '재발송 완료 시각' })
  resendAt: Date | null;

  @Column({ type: 'int', default: 0, comment: '외부 API 재발송 누적 횟수' })
  resendCount: number;

  @Column({ name: 'replaced_from_id', type: 'bigint', nullable: true, comment: '폐기 후 신규 발송 - 원본 OrderDelivery ID' })
  replacedFromId: number | null;

  @Column({ type: 'datetime', nullable: true, comment: '발송 실패 시각' })
  failedAt: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: '발송 배치 중복 처리 방지용 클레임 시각' })
  claimedAt: Date | null;

  @Column({ type: 'datetime', nullable: true, comment: '폐기/환불폐기 시각' })
  discardedAt: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: '환불 발생 시각 (NULL=미환불)' })
  refundedAt: Date | null;

  @Column({ type: 'enum', enum: OrderDeliveryRefundStatusEnum, nullable: true, comment: '환불 상태' })
  refundStatus: OrderDeliveryRefundStatusEnum | null;

  @Column({ type: 'int', nullable: true, comment: '환불 률 1~100 으로 저장 및 사용' })
  refundRatio: number | null;

  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true, comment: '정산 수수료(%)' })
  settleFee: number | null;

  @Column({ type: 'varchar', length: 20, nullable: true, comment: '정산 할인/할증 구분' })
  settlePriceAdjustment: IPriceAdjustment | null;

  @Column({ type: 'varchar', length: 50, nullable: true, comment: '정산 할인 구분' })
  settleDiscountType: IOrderSettleDiscountType | null;

  @Column({ type: 'datetime', nullable: true, comment: '환불 접수 일자' })
  refundRegisterAt: Date | null;

  @Column({ type: 'varchar', nullable: true, comment: '은행명' })
  bankName: string | null;

  @Column({ type: 'varchar', nullable: true, comment: '계좌번호' })
  bankAccount: string | null;

  @Column({ type: 'varchar', nullable: true, comment: '예금주' })
  bankAccountOwner: string | null;

  @Column({ type: 'datetime', nullable: true, comment: '환불일자' })
  refundAt: Date | null;

  @Column({ type: 'datetime', nullable: true, comment: '환불 승인 일자' })
  approveAt: Date | null;

  @Column({ name: 'api_error_code', type: 'varchar', length: 256, nullable: true, comment: '외부 api 응답 에러코드' })
  apiErrorCode: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true, comment: '외부 api 응답 에러메시지' })
  apiErrorMessage: string | null;

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
}
