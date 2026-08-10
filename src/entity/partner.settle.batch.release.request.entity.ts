import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';

/**
 * 확정 해제 멱등 요청 (정본 §5.8 · PR1D · append-only).
 *
 * 같은 `requestKey`·같은 `payloadHash` 재시도 = 기존 결과 200,
 * 같은 key·다른 hash = 409.
 */
@Entity('partner_settle_batch_release_request')
export class PartnerSettleBatchReleaseRequestEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 191, unique: true })
  requestKey: string;

  @Column({ type: 'varchar', length: 128 })
  payloadHash: string;

  @Column({ type: 'varchar', length: 16 })
  payloadHashVersion: string;

  @Column({ type: 'int' })
  releasedBy: number;

  @Column({ type: 'datetime', precision: 6 })
  releasedAt: Date;
}
