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

  // 차감이 어느 발송건 때문에 생겼는지. 부분취소가 "그 발송건 몫만" 복구할 수 있게 하는 근거다.
  // 차감 호출부(deductEventBalanceMultiple)는 이미 발송건별 금액을 받고 있으나 행사 단위로
  // 합산하며 이 값을 버린다 — 새로 계산할 값이 아니라 버리던 값을 저장하면 된다.
  //
  // ※ 아직 이 값을 채우는 코드가 없다. deductEventBalanceMultiple 은 여전히 행사 단위로
  //   합산해 1행만 남기므로, 현재는 신규 행도 전부 NULL 이다. 기록은 후속 커밋에서 붙는다
  //   (행사 단위 합산을 발송건 단위로 분해해야 하므로 한 줄짜리 변경이 아니다).
  //
  // NULL 인 경우: 기록 도입 이전 데이터, 또는 발송건과 무관한 변동(충전 / 재발송 선차감 등).
  @Column({ type: 'int', nullable: true, comment: 'FK) order_delivery id — 차감 귀속 발송건 (부분복구용)' })
  orderDeliveryId: number | null;

  @Column({ type: 'boolean', default: true, comment: '임시 차감 여부 (true: 가차감, false: 확정)' })
  isTemporary: boolean;
}
