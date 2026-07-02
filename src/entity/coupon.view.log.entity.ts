import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { OrderDeliveryEntity } from './order.delivery.entity';

/**
 * 쿠폰 수신(coupon-view) 페이지 방문 로그.
 *
 * 카카오 알림톡 '선물 확인하기' 링크(coupon-view/{encryptKey})로 진입하면 브라우저 JS가
 * GET /order/receive/alim-talk 를 호출한다. 이 API 호출 1건 = 실제 브라우저의 페이지 열람 1회다.
 * (단순 링크 미리보기 크롤러는 SSR HTML만 긁고 이 API를 호출하지 않으므로 자연 필터된다.)
 *
 * 고객이 '페이지를 못 봤다'며 보상을 요구할 때 실제 방문 여부/시각을 판별하는 증거로 사용한다.
 * 방문마다 1행씩 append 하며(모든 방문 기록), createdAt 이 방문 시각이다.
 */
@Index('uk_coupon_view_log_dedup', ['dedupKey'], { unique: true })
@Index('idx_coupon_view_log_delivery_created', ['orderDeliveryId', 'createdAt'])
@Entity('coupon_view_log')
export class CouponViewLogEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', comment: 'FK) order_delivery.id' })
  orderDeliveryId: number;

  @Column({ type: 'varchar', length: 45, nullable: true, comment: '방문자 IP (x-forwarded-for 우선)' })
  ipAddress: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true, comment: 'User-Agent 원문' })
  userAgent: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true, comment: 'Referer 헤더' })
  referer: string | null;

  @Column({ type: 'varchar', length: 20, comment: '진입 경로 (alimtalk: 알림톡, test: 테스트발송)' })
  source: string;

  @Column({
    type: 'varchar',
    length: 120,
    comment: 'dedup 키 "{orderDeliveryId}:{ip}:{10초버킷}" — unique 인덱스로 동시요청 중복방문을 원자적으로 차단',
  })
  dedupKey: string;

  @Column({ type: 'tinyint', width: 1, default: 0, comment: '알려진 크롤러/미리보기 봇 UA 여부 (1=봇)' })
  isBot: boolean;

  @ManyToOne(() => OrderDeliveryEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'order_delivery_id' })
  orderDelivery: OrderDeliveryEntity;
}
