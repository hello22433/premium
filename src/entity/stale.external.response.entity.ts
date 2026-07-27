import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { DeliveryExclusiveOp } from '../delivery/interface/delivery.workflow.status';

/** stale 판정 사유(어느 fencing 조건이 어긋났는지) */
export enum StaleMismatchReason {
  OWNER_TOKEN = 'OWNER_TOKEN',
  GENERATION = 'GENERATION',
  WORKFLOW_VERSION = 'WORKFLOW_VERSION',
  MULTIPLE = 'MULTIPLE',
}

/** 응답이 속한 상태 머신 */
export enum StaleStateMachine {
  PIN = 'PIN',
  MESSAGE = 'MESSAGE',
  REFUND = 'REFUND',
}

/**
 * 3중 fencing 불일치(stale) 외부 응답 감사 보관. §6.1·§8.3.
 *
 * 소유권·세대·workflow 버전 중 하나라도 어긋난 응답은 상태에 반영하지 않지만 **버리지도 않는다**.
 * 이전 호출이 실제로 PIN 을 발급했거나 SMS 를 insert 했을 수 있기 때문이다.
 * 저장 후 해당 상태 머신을 `RECONCILING` 으로 전환 신호하고, 재조회 완료 전 신규 외부 호출을 금지한다.
 *
 * 원본 응답에는 PIN·수신번호·본문 등 민감정보가 포함될 수 있으므로 본문은 **암호화해 저장**하고,
 * 상관키 등 비민감 추적키만 평문 인덱스로 둔다(§8.3).
 */
@Entity('stale_external_response')
@Index('idx_stale_external_response_target', ['stateMachine', 'targetKey'])
@Index('idx_stale_external_response_delivery', ['orderDeliveryId', 'createdAt'])
@Index('idx_stale_external_response_created', ['createdAt'])
export class StaleExternalResponseEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'int', nullable: true, comment: 'FK) order_delivery.id (식별 가능한 경우)' })
  orderDeliveryId: number | null;

  @Column({ type: 'varchar', length: 16 })
  stateMachine: StaleStateMachine;

  @Column({
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: 'attempt_id / pin_issue_command.id / refund_attempt.id',
  })
  targetKey: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, comment: '응답을 유발한 operation' })
  op: DeliveryExclusiveOp | null;

  @Column({ type: 'varchar', length: 64, nullable: true, comment: '응답 소유자 토큰(불일치 근거)' })
  ownerToken: string | null;

  @Column({ type: 'bigint', nullable: true })
  generation: string | null;

  @Column({ type: 'bigint', nullable: true })
  workflowVersion: string | null;

  @Column({ type: 'varchar', length: 32 })
  mismatchReason: StaleMismatchReason;

  @Column({ type: 'mediumtext', comment: '원본 응답 암호문(§8.3 암호화 저장)' })
  responseBodyEnc: string;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;
}
