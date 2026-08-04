import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * 협력사 정산조건 정책 epoch — 이력 read/write 경합 직렬화 지점.
 *
 * 이력 재구성(reader)은 협력사 epoch row 를 `FOR SHARE` 로 잡은 상태에서 재구성과 원장 INSERT 까지
 * 끝내고, 이력 변경(writer: 직접 CRUD · 예약 cron · 소급)은 같은 row 를 `FOR UPDATE` 로 잡고
 * 이력 변경 + `epoch++` 를 한 트랜잭션으로 처리한다. S/X 락 충돌로 직렬화되므로 reader 쪽
 * 별도 재검증·재시도가 필요 없다.
 *
 * REPEATABLE READ 에서는 non-locking SELECT 재검증이 첫 스냅샷에 고정되어 변경을 감지하지 못하므로
 * 이 락이 유일한 방어다.
 */
@Entity('partner_discount_policy_epoch')
export class PartnerDiscountPolicyEpochEntity {
  @PrimaryColumn({ type: 'int', comment: 'FK) partner_company.id' })
  partnerCompanyId: number;

  @Column({ type: 'bigint', default: 0, comment: '정책 변경 카운터 (writer 가 증가)' })
  epoch: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
