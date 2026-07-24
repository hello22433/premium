import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';

@Entity('ssg_event_amount_history')
export class SsgEventAmountHistoryEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', nullable: true, comment: 'FK) ssg event id' })
  ssgEventId: number | null;

  @Column({ type: 'int', nullable: true, comment: '사용 또는 충전 금액' })
  amount: number | null;

  @Column({ type: 'int', default: 0, comment: '신세계 잔액' })
  balance: number;

  @Column({ type: 'int', nullable: true, comment: 'FK) order id' })
  orderId: number | null;

  // ※ 차감 귀속 발송건(order_delivery_id) 컬럼은 **여기 없다.** SSG 발송건별 부분취소를 켤 때
  //   함께 들어간다 — docs/followup-ssg-partial-cancel.md 참조.
  //   컬럼/인덱스 마이그레이션 원본은 커밋 cb5da68 의
  //   sql/migrations/20260722_add_ssg_event_amount_history_delivery.sql 에 남아 있다.
  //   (엔티티가 컬럼을 선언하면 마이그레이션 적용 전 조회가 전부 Unknown column 으로 깨지므로,
  //    쓰는 코드가 생기는 시점에 엔티티·마이그레이션을 같이 넣어야 한다.)

  @Column({ type: 'boolean', default: true, comment: '임시 차감 여부 (true: 가차감, false: 확정)' })
  isTemporary: boolean;
}
