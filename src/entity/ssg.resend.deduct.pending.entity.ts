import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * SSG 재발급 선차감 durable pending 마커 (crash 복구).
 *
 * 재발급(배치 재발송 / CS 폐기후신규)에서 새 행사로 선차감(deductEventBalance)한 뒤 PIN 재발급/발송이
 * 끝나기 전에 프로세스가 크래시하면, 선차감만 영속 커밋되고 역복원할 메모리 식별자(resendDeductionId)는
 * 소실되어 SSG 행사잔액이 영구 과차감(leak)된다.
 *
 * 이를 막기 위해 선차감과 **같은 트랜잭션**에서 본 row 를 INSERT 한다(crash window W1 차단).
 * sweep 이 미해소(resolved_at IS NULL) row 를 CAS lease 로 집어 phase 별로 역복원/유지+repair/재시도한다.
 *
 * - resolved_at IS NULL                : 미해소(크래시 또는 진행 중)
 * - issue_attempted_at IS NULL         : issue() 미시도 → 외부 미등록 확정 → 직접 역복원 대상
 * - issue_attempted_at 존재            : issue() 시도 → issue_order_delivery_id 의 SSG state 로 확정 분기
 */
@Entity('ssg_resend_deduct_pending')
@Index('idx_ssg_resend_pending_sweep', ['resolvedAt', 'recoverLeaseUntil'])
export class SsgResendDeductPendingEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  /** ulid. refundResendEventDeduction(ssg_resend_deduct_recovery UNIQUE) 역복원 멱등키와 동일 값. */
  @Index('uk_ssg_resend_pending_deduction_id', { unique: true })
  @Column({ type: 'varchar', length: 26, name: 'resend_deduction_id' })
  resendDeductionId: string;

  /** 선차감된 신규 행사 id. */
  @Column({ type: 'int', name: 'ssg_event_id' })
  ssgEventId: number;

  @Column({ type: 'int', name: 'order_id' })
  orderId: number;

  /** 선차감액 (= product.price). */
  @Column({ type: 'int', name: 'amount' })
  amount: number;

  /** BATCH_RESEND | CS_REISSUE. sweep 의 issue 대상 delivery 해석 분기 보조(로그/감사). */
  @Column({ type: 'varchar', length: 20, name: 'purpose' })
  purpose: string;

  /**
   * issue() 가 대상으로 하는 delivery id.
   * - BATCH_RESEND: 선차감 시점에 기존 orderDelivery.id 로 확정.
   * - CS_REISSUE  : 선차감 시점엔 신규 delivery 미존재 → NULL. 신규 delivery 저장 후 issue 직전 set.
   * sweep 의 SSG state 확정은 반드시 이 id 로 한다(기존 폐기 delivery 의 CONFIRMED 오판 차단).
   */
  @Column({ type: 'int', name: 'issue_order_delivery_id', nullable: true })
  issueOrderDeliveryId: number | null;

  /** issue() 직전 set. NULL = 외부 미등록 확정(W1) → sweep 이 직접 역복원. */
  @Column({ type: 'datetime', precision: 6, name: 'issue_attempted_at', nullable: true })
  issueAttemptedAt: Date | null;

  /** KEPT/REVERSED 확정 시각. sweep 후보 = NULL 만. */
  @Column({ type: 'datetime', precision: 6, name: 'resolved_at', nullable: true })
  resolvedAt: Date | null;

  /** KEPT(차감 유지) | REVERSED(역복원). */
  @Column({ type: 'varchar', length: 20, name: 'resolution', nullable: true })
  resolution: string | null;

  /** sweep CAS lease 토큰(ulid). */
  @Column({ type: 'varchar', length: 26, name: 'recover_token', nullable: true })
  recoverToken: string | null;

  @Column({ type: 'datetime', precision: 6, name: 'recover_lease_until', nullable: true })
  recoverLeaseUntil: Date | null;

  @Column({ type: 'int', name: 'recover_attempts', default: 0 })
  recoverAttempts: number;

  @Column({ type: 'datetime', precision: 6, name: 'recover_escalated_at', nullable: true })
  recoverEscalatedAt: Date | null;

  @Column({
    type: 'datetime',
    precision: 6,
    name: 'created_at',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  createdAt: Date;
}
