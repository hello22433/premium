import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { IPartnerSettlePaymentRequestStatus } from '../partner_settle/interface/partner.settle.batch.type';

/**
 * paid 멱등키 SoT (정본 §5.7.1 · PR1D).
 *
 * 정상 paid · variance 지급 공통 전역 멱등키.
 * batch 당 `PENDING_VARIANCE` request 는 generated column 으로 1건 강제.
 */
@Entity('partner_settle_payment_request')
@Index('idx_payment_request_batch', ['batchId'])
export class PartnerSettlePaymentRequestEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 191, unique: true })
  paidRequestKey: string;

  @Column({ type: 'int', comment: 'FK) partner_settle_batch.id' })
  batchId: number;

  @Column({ type: 'varchar', length: 128 })
  payloadHash: string;

  @Column({ type: 'varchar', length: 16 })
  payloadHashVersion: string;

  @Column({ type: 'varchar', length: 24, default: 'PENDING_VARIANCE' })
  status: IPartnerSettlePaymentRequestStatus;

  // generated column: DB 전용 (TypeORM 에서 insert 시 무시)
  // pendingVarianceBatchKey: number | null;
}
