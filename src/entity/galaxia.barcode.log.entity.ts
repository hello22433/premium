import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { OrderDeliveryEntity } from './order.delivery.entity';

// INACTIVE 환불/만료 구분 시 existsBy({ orderDeliveryId, appDiv: '81' }) 조회가
// 야간 batch에서 건마다 실행되므로 (order_delivery_id, app_div) 복합 인덱스로 full scan을 방지한다.
@Index('idx_galaxia_barcode_log_delivery_appdiv', ['orderDeliveryId', 'appDiv'])
@Entity('galaxia_barcode_log')
export class GalaxiaBarcodeLogEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', comment: 'FK) order_delivery.id' })
  orderDeliveryId: number;

  @Index()
  @Column({ type: 'varchar', length: 256, comment: '바코드' })
  barcode: string;

  @Column({ type: 'varchar', length: 10, comment: '거래구분 (10:사용, 20:사용취소, 25:망취소, 81:환불등록)' })
  appDiv: string;

  @Index()
  @Column({ type: 'varchar', length: 8, comment: '사용일자 (YYYYMMDD)' })
  appDay: string;

  @Column({ type: 'varchar', length: 6, comment: '사용시간 (HHmmss)' })
  appTime: string;

  @Column({ type: 'int', comment: '사용금액' })
  amount: number;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '승인번호' })
  appNo: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, comment: '사용처(교환처)' })
  appStore: string | null;

  @Column({ type: 'varchar', length: 10, comment: '상품권 종류 (cpn:쿠폰, dept:백화점상품권)' })
  giftKind: string;

  /**
   * 시각 완비 event 의 멱등 identity — `barcode|giftKind|appDiv|appDay|appTime|appNo(NULL→'-')|amount`.
   *
   * DB generated STORED 컬럼이라 애플리케이션은 읽기만 한다(`insert`/`update` false).
   * UNIQUE 는 이 컬럼이 아니라 soft-delete 를 제외한 `active_event_fingerprint` 에 걸려 있다 —
   * raw 컬럼에 직접 걸면 tombstone row 가 동일 fingerprint 를 계속 점유해 재수신이 막힌다.
   */
  @Column({
    type: 'varchar',
    length: 255,
    nullable: true,
    insert: false,
    update: false,
    comment: '[generated] 시각 완비 event 멱등 identity',
  })
  eventFingerprint: string | null;

  @ManyToOne(() => OrderDeliveryEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'order_delivery_id' })
  orderDelivery: OrderDeliveryEntity;
}
