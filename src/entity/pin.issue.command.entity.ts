import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import {
  PartnerResponseClass,
  PinIssueCommandStatus,
  SsgPinResolution,
} from '../delivery/interface/pin.issue.command.status';
import { TrackingCreatedByOp } from '../delivery/interface/delivery.workflow.status';

/**
 * 협력사 PIN 발급 명령 상태 머신. §5.2.
 *
 * - 최초 협력사 요청 **전에** 발급 명령과 작업 선점 정보를 자사 DB에 확정 저장한다.
 *   협력사 호출은 DB 트랜잭션 밖에서 하고, 응답은 3중 fencing 일치 소유자만 반영한다(§6.1).
 * - 최초 발급(`createdByOp = PIN_ISSUE`)은 order_delivery 당 1건만 존재할 수 있다
 *   (DB generated column `initial_issue_key` unique). 재시도는 `RETRY`, 재발급은 `PIN_REISSUE` 소관이다.
 * - `PIN_REISSUE` 는 외부 부작용(신규 발급)이 있는 DUAL op 이므로 `approvalId` 가 필수이며,
 *   승인 없는 재발급은 `§10` 불변식 ②-c 가 이 테이블을 대상으로 탐지한다.
 */
@Entity('pin_issue_command')
@Index('idx_pin_issue_command_delivery', ['orderDeliveryId', 'status'])
@Index('idx_pin_issue_command_status', ['status', 'stateEnteredAt'])
@Index('idx_pin_issue_command_due', ['status', 'nextAttemptAt'])
@Index('idx_pin_issue_command_approval', ['approvalId'])
@Index('uk_pin_issue_command_active_delivery', ['activeOrderDeliveryId'], { unique: true })
export class PinIssueCommandEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'int', comment: 'FK) order_delivery.id' })
  orderDeliveryId: number;

  @Column({ type: 'varchar', length: 24, default: PinIssueCommandStatus.STARTED })
  status: PinIssueCommandStatus;

  @Column({ type: 'varchar', length: 32, comment: '협력사 타입' })
  partnerType: string;

  @Column({ type: 'varchar', length: 191, nullable: true, comment: '협력사 요청 키(trId 등). 멱등/조회 키' })
  requestKey: string | null;

  @Column({ type: 'int', default: 0, comment: '관측용 협력사 발급 시도 횟수' })
  attemptCount: number;

  @Column({ type: 'int', default: 0, comment: '외부 SSG INSERT 실행 권한 소비 횟수(최대 2)' })
  externalIssueCount: number;

  @Column({ type: 'varchar', length: 24, nullable: true, comment: 'SSG 등록 조회 판정' })
  resolution: SsgPinResolution | null;

  @Column({ type: 'int', default: 0, comment: 'SSG 등록 판정 조회 횟수' })
  resolutionLookupCount: number;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: 'SSG 등록 판정 시작 시각' })
  resolutionStartedAt: Date | null;

  @Column({ type: 'varchar', length: 32, nullable: true, comment: 'PARTNER_RESPONSE_* 원본 응답코드' })
  partnerResponseCode: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true, comment: '§9 분류표 버킷' })
  responseClass: PartnerResponseClass | null;

  @Column({ type: 'varchar', length: 64, nullable: true, comment: 'Level B 실행 lease 소유자' })
  ownerToken: string | null;
  @Column({
    type: 'varchar',
    length: 32,
    nullable: true,
    comment: '최초 batch delivery claim ISO token(lease owner와 분리)',
  })
  deliveryClaimToken: string | null;

  @Column({ type: 'bigint', default: 0, comment: 'Level B 세대(3중 fencing)' })
  generation: string;

  @Column({ type: 'bigint', nullable: true, comment: '바인딩된 workflow_version(3중 fencing)' })
  workflowVersion: string | null;

  @Column({ type: 'varchar', length: 24, comment: '생성 출처 op PIN_ISSUE|RETRY|PIN_REISSUE' })
  createdByOp: TrackingCreatedByOp;

  @Column({ type: 'bigint', comment: '생성 시점 workflow_version(승인 대조 조인 키)' })
  createdWorkflowVersion: string;

  @Column({ type: 'bigint', nullable: true, comment: 'DUAL op(PIN_REISSUE)만 필수. dual_approval.id' })
  approvalId: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: 'RETRY_PENDING 재시도 예정 시각' })
  nextAttemptAt: Date | null;
  @Column({ type: 'datetime', precision: 6, nullable: true, comment: '실행 lease 만료 시각' })
  leaseExpiresAt: Date | null;

  @Column({
    type: 'bigint',
    asExpression:
      "CASE WHEN `status` IN ('STARTED','RETRY_PENDING','RETRYING','OPS_REVIEW_REQUIRED') THEN `order_delivery_id` ELSE NULL END",
    generatedType: 'STORED',
    select: false,
    insert: false,
    update: false,
    nullable: true,
  })
  activeOrderDeliveryId: string | null;

  @Column({
    type: 'datetime',
    precision: 6,
    default: () => 'CURRENT_TIMESTAMP(6)',
    comment: '현재 status 진입 시각(표 4-1 체류시간)',
  })
  stateEnteredAt: Date;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: '터미널 확정 시각' })
  resolvedAt: Date | null;

  @Column({
    type: 'smallint',
    name: 'not_issued_streak',
    default: 0,
    comment: '연속 tryYn=N 관측 횟수 (§5-4, streak CAS)',
  })
  notIssuedStreak: number;

  @Column({
    type: 'datetime',
    precision: 6,
    name: 'resolution_deadline_at',
    nullable: true,
    comment: 'resolver 최초 진입 시 1회 저장, 이후 불변 (§7-3)',
  })
  resolutionDeadlineAt: Date | null;

  /**
   * EP-P30 §9-3 drain marker. 새 autoresolve resolver 가 **실제로 이 command 를 변경했는가**.
   *
   * 생성 시점 코드 버전이 아니라 enrollment 여부다. 모드를 `off` 로 내려도 이미 손대본
   * command 는 종결까지 drain 해야 fence 가 영구 잔류하지 않는다. `observe` 는 순수 관측이므로
   * 이 값을 세팅하지 않는다. `workflow_version`(가변 fencing 카운터)으로 대체할 수 없다.
   */
  @Column({
    type: 'smallint',
    name: 'autoresolve_version',
    nullable: true,
    comment: 'P30 autoresolve enrollment marker',
  })
  autoresolveVersion: number | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
