import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * SSG PIN INSERT 시도 로컬 블랙리스트
 *
 * SSG Oracle DB에 INSERT 시도한 PIN을 기록한다.
 * SSG Oracle에는 unique 제약이 없으므로, 중복 INSERT를 방지하기 위해
 * 로컬에서도 사용된 PIN을 추적해야 한다.
 *
 * - REQUIRES_NEW 트랜잭션으로 기록하여 메인 트랜잭션 롤백 시에도 유지
 * - PIN 생성 시 이 테이블을 먼저 조회하여 로컬 중복 검사 (1차)
 * - SSG check API로 SSG DB 중복 검사 (2차)
 */
@Entity('ssg_issue_log')
export class SsgIssueLogEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('idx_ssg_issue_log_bar_code')
  @Column({ type: 'varchar', length: 32, name: 'bar_code', comment: 'SSG INSERT 시도한 barCode' })
  barCode: string;

  @Index('idx_ssg_issue_log_personal_code')
  @Column({ type: 'varchar', length: 32, name: 'personal_code', comment: 'SSG INSERT 시도한 personalCode' })
  personalCode: string;

  @Column({ type: 'int', name: 'order_delivery_id', comment: 'FK) order_delivery.id' })
  orderDeliveryId: number;

  @Column({ type: 'varchar', length: 64, name: 'ssg_transaction_id', comment: 'SSG trId' })
  ssgTransactionId: string;

  @Column({ type: 'varchar', length: 32, name: 'event_no', comment: 'SSG 이벤트 번호' })
  eventNo: string;

  @Column({ type: 'datetime', precision: 6, name: 'inserted_at', comment: 'SSG INSERT 시도 시각' })
  insertedAt: Date;
}
