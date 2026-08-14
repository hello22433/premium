import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * SSG PIN INSERT 시도 로컬 블랙리스트 + orphan resolver payload 저장소
 *
 * SSG Oracle DB에 INSERT 시도한 PIN을 기록한다.
 * SSG Oracle에는 unique 제약이 없으므로, 중복 INSERT를 방지하기 위해
 * 로컬에서도 사용된 PIN을 추적해야 한다.
 *
 * - REQUIRES_NEW 트랜잭션으로 기록하여 메인 트랜잭션 롤백 시에도 유지
 * - PIN 생성 시 이 테이블을 먼저 조회하여 로컬 중복 검사 (1차)
 * - SSG check API로 SSG DB 중복 검사 (2차)
 * - bar_code / personal_code 는 UNIQUE. 위 두 조회는 비원자적(check-to-insert 창)이므로
 *   PIN 후보의 생애 유일성 권위는 이 제약뿐이다. 위반은 SsgIssueLogKeyCollisionError 로 승격되어
 *   발급 경로가 다음 후보로 진행한다.
 *   docs/plans/2026-08-04-ssg-issue-log-unique-typed-collision.md
 *
 * expireAt/encourageAt/couponNum: ATTEMPTED state 복원용 (plans/ssg-balance-refactor.md PR1).
 * orphan resolver가 SSG check 후 등록된 PIN을 우리 DB에 복원할 때 사용.
 */
@Entity('ssg_issue_log')
export class SsgIssueLogEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('uq_ssg_issue_log_bar_code', { unique: true })
  @Column({ type: 'varchar', length: 32, name: 'bar_code', comment: 'SSG INSERT 시도한 barCode' })
  barCode: string;

  @Index('uq_ssg_issue_log_personal_code', { unique: true })
  @Column({ type: 'varchar', length: 32, name: 'personal_code', comment: 'SSG INSERT 시도한 personalCode' })
  personalCode: string;

  @Index('idx_ssg_issue_log_order_delivery_id')
  @Column({ type: 'int', name: 'order_delivery_id', comment: 'FK) order_delivery.id' })
  orderDeliveryId: number;

  @Column({ type: 'varchar', length: 64, name: 'ssg_transaction_id', comment: 'SSG trId' })
  ssgTransactionId: string;

  @Column({ type: 'varchar', length: 32, name: 'event_no', comment: 'SSG 이벤트 번호' })
  eventNo: string;

  /**
   * SSG check() 파라미터 완성용. ssg_event.order 값.
   * legacy row 호환을 위해 nullable. PR2 신규 INSERT 부터는 항상 값 채움.
   * orphan resolver는 NULL 후보를 skip한다.
   */
  @Column({ type: 'int', name: 'event_seq', nullable: true, comment: 'SSG 행사 순번 (ssg_event.order)' })
  eventSeq: number | null;

  /**
   * orphan resolver 복원용 ssg_event FK. legacy row 호환 위해 nullable.
   */
  @Column({ type: 'int', name: 'ssg_event_id', nullable: true, comment: 'FK) ssg_event.id' })
  ssgEventId: number | null;

  @Column({ type: 'datetime', precision: 6, name: 'inserted_at', comment: 'SSG INSERT 시도 시각' })
  insertedAt: Date;

  @Column({ type: 'datetime', name: 'expire_at', nullable: true, comment: 'order_delivery.expire_at (orphan 복원용)' })
  expireAt: Date | null;

  @Column({
    type: 'datetime',
    name: 'encourage_at',
    nullable: true,
    comment: 'order_delivery.encourage_at (orphan 복원용)',
  })
  encourageAt: Date | null;

  @Column({
    type: 'varchar',
    length: 100,
    name: 'coupon_num',
    nullable: true,
    comment: 'order_delivery.coupon_num (orphan 복원용)',
  })
  couponNum: string | null;

  /**
   * EP-P30 §6-A — 발급 차수의 영속화. `external_issue_count` 는 **권한 소비 횟수**지 실제 INSERT
   * 시도 횟수가 아니라, 권한만 소비하고 INSERT 전에 죽은 상태를 구분할 수 없다.
   * (command_id, ordinal) 로그의 존재 여부가 "그 차수의 INSERT 가 있었는가"의 유일한 증인이다.
   *
   * legacy 행과 구버전 프로세스가 쓴 행은 NULL 이며, NULL 은 "시도 없음" 증거로 쓰지 않는다(보수 처리).
   */
  @Column({ type: 'bigint', name: 'pin_issue_command_id', nullable: true, comment: 'FK) pin_issue_command.id' })
  pinIssueCommandId: string | null;

  @Column({ type: 'tinyint', name: 'issue_ordinal', nullable: true, comment: '발급 차수 1=최초, 2=자동 재발급' })
  issueOrdinal: number | null;

  /**
   * EP-P30 §6-D tombstone. 운영 복구·재발급 진입 시 DELETE 대신 표식한다.
   *
   * - 활성 후보(어떤 PIN 을 조회·재사용할가) → `superseded_at IS NULL`
   * - 시도 이력(NOT_ATTEMPTED 판정·재점유 증인)·번호 블랙리스트 → 필터 없음(전체 행)
   */
  @Column({ type: 'datetime', precision: 6, name: 'superseded_at', nullable: true, comment: 'tombstone 시각' })
  supersededAt: Date | null;
}
