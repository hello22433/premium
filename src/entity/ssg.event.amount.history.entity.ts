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
  // ※ 현재 이 값을 채우는 코드는 없다 — deductEventBalanceMultiple 이 행사 단위로 합산해
  //   1행만 남기므로 신규 행도 전부 NULL 이다(행사 단위 합산을 발송건 단위로 분해해야 하는
  //   변경이라 한 줄로 끝나지 않는다). SSG 부분복구를 켜기 전에 반드시 확인할 것.
  //
  // NULL 인 경우: 기록 도입 이전 데이터, 또는 발송건과 무관한 변동(충전 / 재발송 선차감 등).
  //   ※ 부분복구 진입 판정은 행 단위(orderDeliveryId != null)가 아니라 "그 주문의 이력 행이
  //     전부 non-null" 이어야 한다. 한 행이라도 NULL 이면 안분 근거가 불완전한데 행 단위로는
  //     그것이 드러나지 않는다.
  @Column({ type: 'int', nullable: true, comment: 'FK) order_delivery id — 차감 귀속 발송건 (부분복구용)' })
  orderDeliveryId: number | null;

  @Column({ type: 'boolean', default: true, comment: '임시 차감 여부 (true: 가차감, false: 확정)' })
  isTemporary: boolean;
}
