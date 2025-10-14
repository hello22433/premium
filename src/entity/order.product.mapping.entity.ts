import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { OrderEntity } from './order.entity';
import { ProductEntity } from './product.entity';
import { BaseEntity } from '../common/entity/base.entity';
import { OrderDeliveryEntity } from './order.delivery.entity';
import { IOrderSettleDiscountType } from '../order/interface/order.settle.discount.type';
import { IPriceAdjustment } from '../user_discount/interface/price.adjustment';
import { IOrderSendMethod } from '../order/interface/order.send.method';
import { OrderEmailSendType } from '../order/domain/order.email.send.type';

@Entity('order_product_mapping')
export class OrderProductMappingEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) order.id' })
  orderId: number;

  @Column({ comment: 'FK) product.id' })
  productId: number;

  @Column({ comment: '상품 개수' })
  amount: number;

  @Column({ comment: '상품 미리보기 상단 이미지 url' })
  topImagePath: string;

  @Column({ comment: '상품 미리보기 중간 이미지 url' })
  midImagePath: string;

  @Column({
    type: 'enum',
    enum: IOrderSettleDiscountType,
    nullable: true,
    comment: '정산 시 사용되는 할인 구분 ex) 단건: ONE, 계약: CONTRACT ',
  })
  settleDiscountType: IOrderSettleDiscountType | null;

  @Column({
    type: 'enum',
    enum: IPriceAdjustment,
    nullable: true,
    comment: '정산 시 사용되는 할인 방법 ex) 할인: DISCOUNT, 할증: ADDITIONAL ',
  })
  priceAdjustment: IPriceAdjustment | null;

  @Column({
    type: 'int',
    nullable: true,
    comment: '정산 시 사용되는 수수료 (percent) ',
  })
  fee: number | null;

  @Column({
    type: 'varchar',
    nullable: true,
    length: 100,
    comment: '발신 수단 ex) ALIM_TAK : 알림톡, SMS : SMS, EMAIL : email',
  })
  sendMethod: IOrderSendMethod | null;

  @Column({
    type: 'varchar',
    length: 100,
    nullable: true,
    comment: '꼬리 광고 text',
  })
  sendTailText: string | null;

  @Column({
    type: 'int',
    nullable: true,
    comment: '개인정보파기 요청일',
  })
  requestToDestroyPersonalInfoDay: number | null;

  @Column({ type: 'varchar', nullable: true, length: 20, comment: '발신 번호' })
  fromPhoneNumber: string | null;

  @Column({ type: 'varchar', nullable: true, length: 20, comment: '발신 제목' })
  sendTitle: string | null;

  @Column({ type: 'varchar', nullable: true, length: 200, comment: '발신 내용' })
  sendContent: string | null;

  @Column({ type: 'varchar', nullable: true, length: 100, comment: '발신 이메일' })
  fromEmail: string | null;

  @Column({ type: 'varchar', nullable: true, length: 100, comment: 'QR: QR, URL: URL' })
  emailSendType: OrderEmailSendType | null;

  @Column({ type: 'text', nullable: true, comment: '이메일 시 사용 방법' })
  useEmailContent: string | null;

  @Column({ type: 'datetime', nullable: true, comment: '발송 요청 시각' })
  sendRequestAt: Date | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  sendType: string | null;

  @ManyToOne(() => OrderEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'order_id' })
  order: OrderEntity;

  @ManyToOne(() => ProductEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'product_id' })
  product: ProductEntity;

  @OneToMany(() => OrderDeliveryEntity, (orderDelivery) => orderDelivery.orderProductMapping, {
    createForeignKeyConstraints: false,
  })
  orderDeliveries: OrderDeliveryEntity[];
}
