import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { OrderDeliveryEntity } from './order.delivery.entity';

export type GiftielExchangeMatchedBy = 'TR_ID' | 'COUPON_NUMBER' | 'NONE';
export type GiftielExchangeCmdType = 'L1' | 'L2';

/**
 * Giftiel push 교환 이벤트 이력
 *
 * - order_delivery의 현재 상태가 아닌, 모든 L1/L2 이벤트를 시계열로 보존
 * - 월별 정산은 auth_date 범위로 이 테이블을 조회
 * - Pull 배치가 tradeAt/tradePlace를 덮어쓰기 전 이 테이블의 최신 L1 존재 여부를 조건으로 사용
 */
@Entity('giftiel_exchange_history')
@Unique('uk_giftiel_exchange_tr_auth', ['trId', 'cmdType', 'authDate'])
@Index('idx_giftiel_exchange_od_cmd_auth', ['orderDeliveryId', 'cmdType', 'authDate'])
export class GiftielExchangeHistoryEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('idx_giftiel_exchange_order_delivery')
  @Column({
    type: 'int',
    name: 'order_delivery_id',
    nullable: true,
    comment: 'FK) order_delivery.id (매칭 실패 시 NULL)',
  })
  orderDeliveryId: number | null;

  @Column({
    type: 'enum',
    enum: ['TR_ID', 'COUPON_NUMBER', 'NONE'],
    name: 'matched_by',
    comment: '매칭 방식',
  })
  matchedBy: GiftielExchangeMatchedBy;

  @Column({ type: 'varchar', length: 100, name: 'tr_id', comment: '트랜잭션 ID' })
  trId: string;

  @Index('idx_giftiel_exchange_coupon_number')
  @Column({ type: 'varchar', length: 50, name: 'coupon_number', comment: '쿠폰번호' })
  couponNumber: string;

  @Column({
    type: 'enum',
    enum: ['L1', 'L2'],
    name: 'cmd_type',
    comment: '처리타입 (L1: 교환, L2: 교환취소)',
  })
  cmdType: GiftielExchangeCmdType;

  @Column({ type: 'varchar', length: 4, name: 'serv_code', comment: '판매사 코드' })
  servCode: string;

  @Column({ type: 'varchar', length: 20, name: 'auth_code', nullable: true, comment: '승인번호' })
  authCode: string | null;

  @Index('idx_giftiel_exchange_auth_date')
  @Column({ type: 'datetime', name: 'auth_date', comment: '교환일시 / 교환취소일시' })
  authDate: Date;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 2,
    name: 'use_price',
    nullable: true,
    comment: '사용금액 / 취소금액',
  })
  usePrice: string | null;

  @Column({ type: 'decimal', precision: 20, scale: 2, name: 'bal_price', nullable: true, comment: '잔액' })
  balPrice: string | null;

  @Column({
    type: 'varchar',
    length: 2,
    name: 'coupon_type',
    nullable: true,
    comment: '쿠폰 종류 (00: 교환/할인권, 02: 금액권)',
  })
  couponType: string | null;

  @Column({ type: 'varchar', length: 20, name: 'bi_code', nullable: true, comment: '사용가맹점 코드' })
  biCode: string | null;

  @Column({ type: 'varchar', length: 50, name: 'bi_name', nullable: true, comment: '사용가맹점 명' })
  biName: string | null;

  @Column({ type: 'varchar', length: 19, name: 'date_time', nullable: true, comment: 'Giftiel 전달일시' })
  dateTime: string | null;

  @Column({ type: 'varchar', length: 4, name: 'result_code', nullable: true, comment: 'Giftiel 응답코드' })
  resultCode: string | null;

  @Column({ type: 'varchar', length: 500, name: 'result_msg', nullable: true, comment: 'Giftiel 응답메시지' })
  resultMsg: string | null;

  @Column({ type: 'varchar', length: 45, name: 'request_ip', comment: '요청 IP' })
  requestIp: string;

  @Column({ type: 'datetime', name: 'received_at', default: () => 'CURRENT_TIMESTAMP', comment: '수신 시각' })
  receivedAt: Date;

  @ManyToOne(() => OrderDeliveryEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'order_delivery_id' })
  orderDelivery?: OrderDeliveryEntity;
}
