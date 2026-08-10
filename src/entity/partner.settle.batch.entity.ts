import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import {
  IPartnerSettleBatchStatus,
  IPartnerSettleBatchType,
} from '../partner_settle/interface/partner.settle.batch.type';

/**
 * 협력사 정산확정 배치 (정본 §5.2 · PR1D).
 *
 * batch 생성 = 기간 내 미정산 원장을 일괄 귀속(confirm). 지급(paid)은 별도 단계다.
 * - `CONFIRMED_UNPAID` → `PAID` (지급 완료) 또는 `CANCELED` (전체/건별 해제)
 * - `confirmedTotalAmount`/`confirmedCount` 는 확정 시점 동결값(감사용). 부분 해제에도 불변.
 * - 실제 지급·carry 기준은 `finalizedTotalAmount` (PAID 시점 재동결).
 *
 * DB CHECK: 상태·타입 조합 + 중복 확정 방지 generated column `activePeriodKey`.
 */
@Entity('partner_settle_batch')
@Index('idx_partner_settle_batch_partner_status', ['partnerCompanyId', 'status'])
@Index('idx_partner_settle_batch_partner_period', ['partnerCompanyId', 'periodEnd'])
export class PartnerSettleBatchEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', comment: 'FK) partner_company.id' })
  partnerCompanyId: number;

  @Column({ type: 'date', comment: 'exclusive 종료 경계 (KST)' })
  periodEnd: string;

  @Column({ type: 'int' })
  confirmedBy: number;

  @Column({ type: 'datetime', precision: 6 })
  confirmedAt: Date;

  @Column({ type: 'bigint', comment: '확정 시점 동결 합계' })
  confirmedTotalAmount: string;

  @Column({ type: 'int', comment: '확정 시점 동결 건수' })
  confirmedCount: number;

  @Column({ type: 'varchar', length: 24, default: 'CONFIRMED_UNPAID' })
  status: IPartnerSettleBatchStatus;

  @Column({ type: 'varchar', length: 24, default: 'NORMAL' })
  batchType: IPartnerSettleBatchType;

  @Column({ type: 'varchar', length: 191, nullable: true, comment: 'confirm 멱등 키 (NORMAL 필수)' })
  requestKey: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  payloadHash: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  payloadHashVersion: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  paidAt: Date | null;

  @Column({ type: 'int', nullable: true })
  paidBy: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  paymentEvidenceRef: string | null;

  @Column({ type: 'varchar', length: 191, nullable: true, comment: 'OPENING_IMPORT 전용' })
  importRunId: string | null;

  @Column({ type: 'bigint', nullable: true, comment: 'PAID 시점 직전 batch carryOut 확정. 미지급 NULL' })
  carryInAmount: string | null;

  @Column({ type: 'bigint', nullable: true, comment: 'PAID 시점 재동결 유효 합계' })
  finalizedTotalAmount: string | null;

  @Column({ type: 'bigint', nullable: true, comment: 'min(0, finalized+carryIn). 미지급 NULL' })
  carryOutAmount: string | null;

  @Column({ type: 'int', nullable: true, comment: 'FK) partner_settle_payment_request.id. NORMAL PAID 시 필수' })
  paymentRequestId: number | null;

  @Column({ type: 'varchar', length: 191, nullable: true, comment: 'payment_request 감사 복사본' })
  paidRequestKey: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  paidPayloadHash: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  paidPayloadHashVersion: string | null;

  @Column({ type: 'bigint', nullable: true, comment: '확정 현금 지급액' })
  paidAmount: string | null;

  @Column({ type: 'bigint', nullable: true, comment: '원장+carry 계산 지급예정액' })
  calculatedPaidAmount: string | null;

  @Column({ type: 'bigint', nullable: true, comment: '실제 송금액' })
  actualPaidAmount: string | null;

  @Column({ type: 'int', nullable: true })
  canceledBy: number | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  canceledAt: Date | null;

  // generated column: DB 전용 (TypeORM 에서 insert 시 무시)
  // activePeriodKey: string | null;
}
