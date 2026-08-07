import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { ExternalApiPinInventoryRequestStatus } from '../inventory_coupon/domain/inventory.pin.status';

/**
 * 외부 API 재고형 쿠폰 사용 신청. rev5 §4.10.
 * 같은 app에 PENDING 1개만 허용 (generated column + UNIQUE).
 */
@Entity('external_api_pin_inventory_request')
@Index('uk_request_pending_app', ['pendingApiAppId'], { unique: true })
export class ExternalApiPinInventoryRequestEntity extends BaseEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', comment: 'FK) api_app.id' })
  apiAppId: string;

  @Column({ type: 'varchar', length: 20, comment: 'PENDING/APPROVED/REJECTED/CANCELLED' })
  status: ExternalApiPinInventoryRequestStatus;

  /**
   * Generated stored column: CASE WHEN status='PENDING' THEN api_app_id ELSE NULL END.
   * UNIQUE 제약으로 같은 app에 PENDING 1개만 강제한다.
   * TypeORM에서는 DB의 generated column을 매핑만 한다.
   */
  @Column({ type: 'bigint', nullable: true, comment: 'generated: PENDING일 때만 apiAppId' })
  pendingApiAppId: string | null;

  @Column({ type: 'int', comment: '요청자 사용자 ID' })
  requestedByUserId: number;

  @Column({ type: 'varchar', length: 500, comment: '요청 사유' })
  requestReason: string;

  @Column({ type: 'int', nullable: true, comment: '결정자 사용자 ID' })
  decidedByUserId: number | null;

  @Column({ type: 'varchar', length: 500, nullable: true, comment: '결정 사유' })
  decisionReason: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: '결정 시각' })
  decidedAt: Date | null;
}
