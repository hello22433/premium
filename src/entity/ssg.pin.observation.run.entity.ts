import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { SsgPinResolution } from '../partner_company_extern/interface/ssg.issue';

/**
 * EP-P30 §9-3 관측 실행 1건. `observe` 모드가 durable state 를 전혀 바꾸지 않고 판정 결과만 쌓는 곳.
 *
 * `observation_bucket_at`(5분 버킷) + command 의 UNIQUE 가 다중 인스턴스 중복 관측을 막는다.
 * observe 는 command/claim 을 건들지 않아 상호배제 장치가 없으므로, 같은 시점의 중복 3행이
 * "연속 3회 N" 으로 오판되는 것을 이 제약 하나가 막는다(경합 패자는 기록 생략 — 오류 아님).
 *
 * `completed_at` 이 NULL 인 행은 집계에서 제외한다. run 과 candidate 는 한 트랜잭션으로 쓴다.
 */
@Entity('ssg_pin_observation_run')
@Index('uq_ssg_pin_observation_run_bucket', ['pinIssueCommandId', 'observationBucketAt'], { unique: true })
@Index('idx_ssg_pin_observation_run_delivery', ['orderDeliveryId', 'observedAt'])
export class SsgPinObservationRunEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', name: 'pin_issue_command_id', comment: 'FK) pin_issue_command.id' })
  pinIssueCommandId: string;

  @Column({ type: 'int', name: 'order_delivery_id', comment: 'FK) order_delivery.id' })
  orderDeliveryId: number;

  @Column({ type: 'datetime', precision: 6, name: 'observation_bucket_at', comment: '5분 버킷(중복 관측 방지)' })
  observationBucketAt: Date;

  @Column({ type: 'varchar', length: 24, name: 'aggregate_resolution', comment: '집계 판정' })
  aggregateResolution: SsgPinResolution;

  @Column({ type: 'varchar', length: 16, comment: '관측 시점 SSG_PIN_AUTORESOLVE_MODE' })
  mode: string;

  @Column({ type: 'int', name: 'candidate_count', comment: '기록한 후보 수(완전성 검증용)' })
  candidateCount: number;

  /**
   * 관측 **당시** command 스냅샷. 이게 없으면 사후 분석에서 정상 in-flight 표본을 걸러낼 수 없다.
   * (발급 진행 중인 STARTED/count=0 은 로그 0행이라 NOT_ATTEMPTED 로 보인다 — 미시도가 아니라 '아직'이다.)
   */
  @Column({ type: 'varchar', length: 24, name: 'command_status', comment: '관측 당시 command status' })
  commandStatus: string;

  @Column({ type: 'int', name: 'external_issue_count', comment: '관측 당시 INSERT 권한 소비 횟수' })
  externalIssueCount: number;

  @Column({ type: 'datetime', precision: 6, name: 'state_entered_at', nullable: true, comment: '관측 당시 체류 시작' })
  stateEnteredAt: Date | null;

  @Column({ type: 'datetime', precision: 6, name: 'lease_expires_at', nullable: true, comment: '관측 당시 lease 만료' })
  leaseExpiresAt: Date | null;

  @Column({ type: 'datetime', precision: 6, name: 'observed_at' })
  observedAt: Date;

  @Column({ type: 'datetime', precision: 6, name: 'completed_at', nullable: true, comment: '저장 완료 표식' })
  completedAt: Date | null;
}
