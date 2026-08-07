import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { IPriceAdjustment } from '../user_discount/interface/price.adjustment';
import {
  IPartnerSettleLedgerStatus,
  IPartnerSettlePricingResolution,
  IPartnerSettleReviewCode,
  IPartnerSettleReviewResolution,
  IPartnerSettleSourceEventIdOrigin,
  IPartnerSettleSourceType,
  IPartnerSettleVatCalculationMode,
} from '../partner_settle/interface/partner.settle.source.type';

/**
 * 협력사 정산 이벤트 원장 (SoT · append-only).
 *
 * 사실·금액 필드는 불변이다. 환불·사용취소·차감은 **음수 row 추가**로만 표현하며, 취소 row 는
 * 원본의 조건 스냅샷을 그대로 반대 부호로 복제한다(취소 시점 재계산 금지).
 *
 * 예외는 셋뿐이다.
 * - `settleBatchId` — 확정(NULL→id)·해제(id→NULL) 두 절차로만 변경 (PR1D)
 * - 미정산 row 의 `appliedPricePercent`/`appliedPriceAdjustment`/`settleAmount` — 소급 재계산 (PR3)
 * - 격리 carve-out — `TIME_UNRECOVERABLE` 의 occurredAt, `PRICE_UNRECOVERABLE` 의 baseAmount 각 1회 (PR1C)
 *
 * 금액은 전부 `BIGINT`(원 단위 정수)다. 계산은 `BigInt` 정수산술로 하며 `number` 산술을 쓰지 않는다.
 * TypeORM 은 bigint 를 문자열로 반환하므로 읽는 쪽에서 `BigInt(...)` 로 파싱한다.
 *
 * DB 가 강제하는 불변식(마이그레이션 `20260804_partner_credit_pr1b_ledger.sql` 및 PR1C):
 * - `UNIQUE(idempotencyKey)` — 전이 단위 멱등
 * - `UNIQUE(transitionObservationId, transitionSequenceNo, transitionAllocationNo)`
 * - `UNIQUE(orphanSettlementKey)` — 양수 orphan 정산은 ingress 당 1건 (음수 배분은 generated NULL 이라 제외)
 * - (status, reviewCode) 조합별 필수/금지 필드, pricingResolution 정합, reviewResolution 조합
 * - 전이 event 의 observation·순번·allocation·origin both-or-neither
 */
@Entity('partner_settle_ledger')
@Index('idx_partner_settle_ledger_unsettled', ['partnerCompanyId', 'subItemKey', 'settleBatchId'])
@Index('idx_partner_settle_ledger_sweep', ['partnerCompanyId', 'settleBatchId', 'status', 'occurredAt', 'id'])
@Index('idx_partner_settle_ledger_occurred', ['occurredAt'])
@Index('idx_partner_settle_ledger_delivery', ['orderDeliveryId'])
@Index('idx_partner_settle_ledger_reverses', ['reversesLedgerId'])
export class PartnerSettleLedgerEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', comment: 'FK) partner_company.id' })
  partnerCompanyId: number;

  @Column({ type: 'varchar', length: 32, comment: '하위항목 키 (GALAXIA 4종·CULTURE 2종·그 외 NONE)' })
  subItemKey: string;

  @Column({ type: 'varchar', length: 16, comment: 'ISSUANCE|EXCHANGE|USAGE|ADJUSTMENT' })
  sourceType: IPartnerSettleSourceType;

  @Column({ type: 'int', nullable: true, comment: 'FK) order_delivery.id. 순수 수동조정만 NULL' })
  orderDeliveryId: number | null;

  @Column({ type: 'int', nullable: true, comment: 'FK) galaxia_barcode_log.id. USAGE 만' })
  galaxiaBarcodeLogId: number | null;

  @Column({
    type: 'datetime',
    precision: 6,
    nullable: true,
    comment: '귀속 시점. TIME_UNRECOVERABLE 격리 동안만 NULL',
  })
  occurredAt: Date | null;

  @Column({ type: 'bigint', nullable: true, comment: '정가/사용액. 취소는 음수' })
  baseAmount: string | null;

  @Column({ type: 'bigint', default: 0, comment: '할인금액 스냅샷' })
  discountAmount: string;

  @Column({ type: 'bigint', default: 0, comment: '받는수수료 (ADDITIONAL)' })
  receivingCommissionAmount: string;

  @Column({ type: 'bigint', default: 0, comment: '주는수수료 (DISCOUNT)' })
  givingCommissionAmount: string;

  @Column({ type: 'bigint', default: 0, comment: 'VAT signed' })
  vatAmount: string;

  @Column({
    type: 'varchar',
    length: 24,
    default: 'NONE',
    comment: 'SEPARATE_ROUND|INCLUDED_REMAINDER|NONE',
  })
  vatCalculationMode: IPartnerSettleVatCalculationMode;

  @Column({ type: 'bigint', default: 0, comment: 'giving - receiving + vat' })
  feeTotalAmount: string;

  @Column({
    type: 'decimal',
    precision: 7,
    scale: 4,
    nullable: true,
    comment: '거래 당시 수수료율(%) exact 스냅샷',
  })
  appliedPricePercent: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true, comment: 'DISCOUNT|ADDITIONAL' })
  appliedPriceAdjustment: IPriceAdjustment | null;

  @Column({ type: 'int', nullable: true, comment: 'FK) partner_discount_history.id' })
  appliedDiscountHistoryId: number | null;

  @Column({
    type: 'varchar',
    length: 24,
    nullable: true,
    comment: 'HISTORY_MATCH|NO_MATCH|DIRECT_AMOUNT',
  })
  pricingResolution: IPartnerSettlePricingResolution | null;

  @Column({ type: 'bigint', nullable: true, comment: 'base - discount - feeTotal' })
  settleAmount: string | null;

  @Column({
    type: 'varchar',
    length: 255,
    charset: 'utf8mb4',
    collation: 'utf8mb4_bin',
    comment: '전이 단위 멱등 키 (UNIQUE)',
  })
  idempotencyKey: string;

  @Column({ type: 'int', nullable: true, comment: 'NULL = 미정산. FK 는 PR1D' })
  settleBatchId: number | null;

  @Column({ type: 'varchar', length: 16, default: 'NORMAL', comment: 'NORMAL|NEEDS_REVIEW|ON_HOLD' })
  status: IPartnerSettleLedgerStatus;

  @Column({ type: 'varchar', length: 32, nullable: true, comment: '격리 원인' })
  reviewCode: IPartnerSettleReviewCode | null;

  @Column({ type: 'varchar', length: 16, nullable: true, comment: 'PENDING|DISCARDED' })
  reviewResolution: IPartnerSettleReviewResolution | null;

  @Column({ type: 'int', nullable: true, comment: 'FK) user.id — DISCARDED 종결자' })
  resolvedBy: number | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  resolvedAt: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true, comment: '이 event 자기 전이의 증적 참조' })
  providerEvidenceRef: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true, comment: '이 event 자기 전이의 증적 hash' })
  providerEvidenceHash: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true, comment: '조정·차감 사유 등' })
  memo: string | null;

  @Column({ type: 'int', nullable: true, comment: '역분개 대상 원본 ledger id' })
  reversesLedgerId: number | null;

  @Column({ type: 'int', nullable: true, comment: 'FK) partner_settle_transition_observation.id' })
  transitionObservationId: number | null;

  @Column({ type: 'int', nullable: true, comment: '같은 observation 내 event 순번 (정상 감지 = 1)' })
  transitionSequenceNo: number | null;
  @Column({ type: 'int', nullable: true, comment: '같은 전이 내 역분개 allocation 순번 (1..N)' })
  transitionAllocationNo: number | null;

  @Column({ type: 'varchar', length: 16, nullable: true, comment: 'PROVIDER|MANUAL' })
  sourceEventIdOrigin: IPartnerSettleSourceEventIdOrigin | null;

  @Column({ type: 'int', nullable: true, comment: 'FK 는 PR1C' })
  reviewResolutionId: number | null;

  @Column({ type: 'int', nullable: true, comment: 'FK 는 PR1C' })
  manualLedgerProposalId: number | null;

  @Column({ type: 'int', nullable: true, comment: 'orphan lane inbox row (자동/수동 상호배타 축)' })
  orphanInboxRowId: number | null;

  @Column({ type: 'int', nullable: true, comment: 'FK·CHECK 일체는 PR3' })
  paymentVarianceProposalId: number | null;
}
