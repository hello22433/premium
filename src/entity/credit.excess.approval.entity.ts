import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum CreditExcessApprovalStatus {
  /** 기업관리자 요청 접수. 운영자 승인 대기 */
  PENDING = 'PENDING',
  /** 운영자 승인 선점 완료. 서버 발송확정 실행 중 */
  PROCESSING = 'PROCESSING',
  /** 발송확정 + 배치 대기(WAIT) 등록 완료 */
  COMPLETED = 'COMPLETED',
  /** 발송확정 실패 (시스템/도메인 오류) */
  FAILED = 'FAILED',
  /** 승인 대기 중 주문 내용이 변경되어 재요청 필요 */
  RE_REQUEST_REQUIRED = 'RE_REQUEST_REQUIRED',
  /** 운영자 명시 거절 */
  REJECTED = 'REJECTED',
  /** 만료/일괄 종료 */
  EXPIRED = 'EXPIRED',
}

/** 실행 중(선점됨) 또는 대기 중 = 같은 주문에 하나만 존재 가능 */
export const CREDIT_EXCESS_ACTIVE_STATUSES: CreditExcessApprovalStatus[] = [
  CreditExcessApprovalStatus.PENDING,
  CreditExcessApprovalStatus.PROCESSING,
];

/** 스냅샷 payload schema 버전. 구조 변경 시 증가 → 과거 버전 요청은 재요청 필요로 종료. */
export const CREDIT_EXCESS_SNAPSHOT_VERSION = 1;

@Entity('credit_excess_approval')
@Index('idx_credit_excess_order', ['orderId'])
@Index('idx_credit_excess_status', ['status'])
@Index('idx_credit_excess_lease', ['status', 'leaseExpiresAt'])
export class CreditExcessApprovalEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'int' })
  orderId: number;

  @Column({ type: 'bigint', nullable: true, comment: 'LEGACY 모드 등 wallet 미해석 시 null' })
  walletAccountId: string | null;

  @Column({ type: 'int', comment: '요청 시점 서버 계산 청구 금액' })
  requestedAmount: number;

  @Column({ type: 'int', comment: '요청 시점 서버 계산 신용초과액' })
  requestedCreditExcessAmount: number;

  @Column({ type: 'varchar', length: 200, comment: '요청 사유 (필수)' })
  reasonText: string;

  @Column({ type: 'int', comment: '요청한 user.id (기업관리자 = 주문 과금 대상)' })
  requestedBy: number;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  requestedAt: Date;

  @Column({
    type: 'varchar',
    length: 24,
    default: CreditExcessApprovalStatus.PENDING,
    comment: 'PENDING | PROCESSING | COMPLETED | FAILED | RE_REQUEST_REQUIRED | REJECTED | EXPIRED',
  })
  status: CreditExcessApprovalStatus;

  /**
   * 같은 주문의 활성 요청(PENDING/PROCESSING) 중복 생성을 DB 레벨에서 차단하는 생성 컬럼.
   * 종료 상태 row 는 NULL 이라 unique 제약에서 제외된다.
   */
  @Index('uq_credit_excess_active_order', { unique: true })
  @Column({
    type: 'int',
    nullable: true,
    asExpression: "(CASE WHEN `status` IN ('PENDING','PROCESSING') THEN `order_id` ELSE NULL END)",
    generatedType: 'STORED',
    insert: false,
    update: false,
    select: false,
    comment: '활성 요청 unique key (생성 컬럼)',
  })
  activeOrderKey: number | null;

  @Column({ type: 'int', nullable: true, comment: '승인/거절한 user.id (운영관리자)' })
  approvedBy: number | null;

  @Column({ type: 'datetime', nullable: true, precision: 6 })
  approvedAt: Date | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  rejectReason: string | null;

  @Column({
    type: 'datetime',
    nullable: true,
    precision: 6,
    comment: '발송확정에서 사용된 시각 (조건부 UPDATE로 1회만 사용 보장)',
  })
  consumedAt: Date | null;

  // ===== 서버 실행(승인 → 발송확정) 제어 =====

  @Column({
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: 'PROCESSING 선점 토큰 (fencing). 실행 표식·최종화·복구 판정 기준',
  })
  attemptToken: string | null;

  @Column({ type: 'int', default: 0, comment: 'PROCESSING 선점 횟수' })
  attemptCount: number;

  @Column({ type: 'datetime', nullable: true, precision: 6, comment: 'PROCESSING lease 만료 시각' })
  leaseExpiresAt: Date | null;

  @Column({ type: 'datetime', nullable: true, precision: 6 })
  processingStartedAt: Date | null;

  @Column({ type: 'datetime', nullable: true, precision: 6, comment: '종료 상태 확정 시각' })
  finishedAt: Date | null;

  // ===== 결과 (운영 진단 / 사용자 노출 분리) =====

  @Column({ type: 'varchar', length: 64, nullable: true, comment: '운영 진단 코드 (안정 식별자)' })
  diagnosticCode: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true, comment: '요청자 노출 메시지' })
  userMessage: string | null;

  @Column({ type: 'json', nullable: true, comment: '변경된 항목명 목록 (요청자 노출)' })
  changedFields: string[] | null;

  @Column({ type: 'varchar', length: 500, nullable: true, comment: '내부 원인 (운영자 전용)' })
  internalReason: string | null;

  // ===== PII 최소화 스냅샷 =====

  @Column({ type: 'int', nullable: true, comment: '스냅샷 schema version' })
  snapshotVersion: number | null;

  @Column({ type: 'json', nullable: true, comment: 'PII 최소화 주문/분배 스냅샷 (수신처는 지문만 저장)' })
  snapshot: Record<string, unknown> | null;
}
