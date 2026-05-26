import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { OrderDeliveryEntity } from './order.delivery.entity';

// INACTIVE 환불/만료 구분 시 existsBy({ orderDeliveryId, appDiv: '81' }) 조회가
// 야간 batch에서 건마다 실행되므로 (order_delivery_id, app_div) 복합 인덱스로 full scan을 방지한다.
@Index(['orderDeliveryId', 'appDiv'])
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

  @ManyToOne(() => OrderDeliveryEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'order_delivery_id' })
  orderDelivery: OrderDeliveryEntity;
}
