import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import {
  MessageAttemptChannel,
  MessageAttemptStatus,
  MessageAttemptType,
  MessageCancelReason,
  MessageCancelResolution,
} from '../delivery/interface/message.attempt.status';
import { DeliveryExclusiveOp } from '../delivery/interface/delivery.workflow.status';

/**
 * 알림톡/SMS/MMS 개별 시도 상태 머신. §5.3.
 *
 * - `attemptId` 는 Gemtek `MSG_QUEUE.EXT_COL2` 에 기록되는 상관키(무작위 UUID hex 32자)다.
 *   주문번호처럼 추측 가능한 값이나 개인정보(수신번호·이름)를 넣지 않는다(§3 다·§8.3).
 * - 한 행은 단일 `mseq` 에 고정된다. 재발송은 `retryOfAttemptId` 로 연결된 **새 행**이며
 *   기존 행의 `mseq` 를 교체하지 않는다.
 * - `rootAttemptId` 는 체인 식별자다. 504 자동 재발송은 `(rootAttemptId, 'AUTO_504')` unique 로
 *   체인당 1회만 허용해 무한 연쇄를 차단한다(DB generated column `retry_scope_key`).
 * - 취소 의도(`cancelRequestedAt`/`cancelReason`)는 슬롯 점유 트랜잭션에서 **먼저 커밋**하고,
 *   재조정·크래시를 거쳐도 유실되지 않는다. 종결 시 반드시 `cancelResolution` 이 채워진다(§10 불변식 ③).
 * - 결과 조회는 확정월 파티션(`MSG_RESULT_yyyyMM`)을 증분 탐색한다(§7.3).
 *   `receiptMonth`/`lastSearchedMonth`/`nextSearchMonth` 가 그 커서다.
 */
@Entity('message_attempt')
@Index('idx_message_attempt_delivery', ['orderDeliveryId', 'status'])
@Index('idx_message_attempt_status', ['status', 'stateEnteredAt'])
@Index('idx_message_attempt_due', ['status', 'nextAttemptAt'])
@Index('idx_message_attempt_mseq', ['mseq'])
@Index('idx_message_attempt_root', ['rootAttemptId', 'attemptType'])
@Index('idx_message_attempt_cancel', ['cancelRequestedAt', 'cancelResolution'])
@Index('idx_message_attempt_approval', ['approvalId'])
export class MessageAttemptEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Index('uk_message_attempt_attempt_id', { unique: true })
  @Column({ type: 'char', length: 32, comment: '상관키(EXT_COL2). 무작위 UUID hex 32자' })
  attemptId: string;

  @Column({ type: 'int', comment: 'FK) order_delivery.id' })
  orderDeliveryId: number;

  @Column({ type: 'varchar', length: 16 })
  channel: MessageAttemptChannel;

  @Column({ type: 'varchar', length: 24 })
  attemptType: MessageAttemptType;

  @Column({ type: 'int', default: 1, comment: '동일 유형 내 순번(MANUAL_RESEND 다회 허용)' })
  attemptSeq: number;

  @Column({ type: 'char', length: 32, nullable: true, comment: '직전 시도 attemptId. NULL 이면 최초 시도' })
  retryOfAttemptId: string | null;

  @Column({ type: 'char', length: 32, comment: '체인 식별자(최초 시도의 attemptId 상속)' })
  rootAttemptId: string;

  @Column({ type: 'varchar', length: 24, default: MessageAttemptStatus.OUTBOX_READY })
  status: MessageAttemptStatus;

  @Column({ type: 'varchar', length: 32, nullable: true, comment: '발송 원인(화면 노출용)' })
  sendReason: string | null;

  @Column({ type: 'bigint', nullable: true, comment: 'Gemtek MSG_QUEUE.MSEQ (insert OUTPUT 으로 확보)' })
  mseq: string | null;

  @Column({ type: 'varchar', length: 4, nullable: true, comment: '원본 STAT (확정 여부)' })
  gemtekStat: string | null;

  @Column({ type: 'varchar', length: 8, nullable: true, comment: '원본 RESULT (GEMTEK_RESULT_*)' })
  gemtekResult: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  sendTime: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: 'Gemtek REPORT_TIME(확정 시각)' })
  reportTime: Date | null;

  @Column({ type: 'char', length: 6, nullable: true, comment: '접수월 yyyyMM (MSEQ 채번월)' })
  receiptMonth: string | null;

  @Column({ type: 'char', length: 6, nullable: true, comment: '마지막 조회 완료 월' })
  lastSearchedMonth: string | null;

  @Column({ type: 'char', length: 6, nullable: true, comment: '다음 사이클 조회 시작 월' })
  nextSearchMonth: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: 'RETRY_SCHEDULED 재발송 예정 시각' })
  nextAttemptAt: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true, comment: 'Level B 실행 lease 소유자' })
  ownerToken: string | null;

  @Column({ type: 'bigint', default: 0, comment: 'Level B 세대(3중 fencing)' })
  generation: string;

  @Column({ type: 'bigint', nullable: true, comment: '바인딩된 workflow_version(3중 fencing)' })
  workflowVersion: string | null;

  @Column({ type: 'varchar', length: 24, comment: '생성 출처 op MESSAGE_SEND|RETRY|MANUAL_RESEND' })
  createdByOp: DeliveryExclusiveOp;

  @Column({ type: 'bigint', comment: '생성 시점 workflow_version(승인 대조 조인 키)' })
  createdWorkflowVersion: string;

  @Column({ type: 'bigint', nullable: true, comment: 'DUAL op(MANUAL_RESEND)만 필수. dual_approval.id' })
  approvalId: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: 'durable cancel intent 커밋 시각' })
  cancelRequestedAt: Date | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  cancelReason: MessageCancelReason | null;

  @Column({ type: 'varchar', length: 24, nullable: true, comment: '열린 intent 금지 — 종결 시 필수' })
  cancelResolution: MessageCancelResolution | null;

  @Column({
    type: 'datetime',
    precision: 6,
    default: () => 'CURRENT_TIMESTAMP(6)',
    comment: '현재 status 진입 시각(표 4-1 체류시간)',
  })
  stateEnteredAt: Date;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: '터미널 확정 시각' })
  resolvedAt: Date | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
