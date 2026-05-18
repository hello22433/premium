import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { SsgInsertState } from '../delivery/interface/ssg.insert.state';

/**
 * SSG INSERT durable state 신호 — 별 테이블로 격리.
 * plans/ssg-balance-refactor.md PR1.
 *
 * `order_delivery`에 컬럼으로 두면 같은 흐름의 `save(orderDelivery)`가 stale 메모리 값으로
 * 신호를 덮어쓸 위험이 있다 (refundedAt에서 발생한 패턴). ledger 패턴 일관 적용으로
 * 신호 데이터를 별 테이블로 격리해 무결성을 영구 보존한다.
 *
 * Lazy 정책:
 * - row 없음 = NONE 해석. 컬럼에 'NONE' 값을 저장하지 않음.
 * - `SsgInsertStateService.markAttempted()`가 최초 INSERT (UPSERT).
 * - `getState()`는 row 없으면 NONE 반환.
 *
 * attempt history는 저장하지 않는다 (현재 상태 1행만). attempt 단위 payload는 `ssg_issue_log`.
 */
@Entity('order_delivery_ssg_insert_state')
export class OrderDeliverySsgInsertStateEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('uq_order_delivery_id', { unique: true })
  @Column({ type: 'int', name: 'order_delivery_id', comment: 'FK) order_delivery.id (UNIQUE = 현재 상태 1행)' })
  orderDeliveryId: number;

  @Column({
    type: 'enum',
    enum: [SsgInsertState.ATTEMPTED, SsgInsertState.CONFIRMED, SsgInsertState.FAILED],
    comment: 'SSG INSERT durable state. NONE은 row 없음으로 표현되며 컬럼에 저장하지 않음',
  })
  state: SsgInsertState;

  @CreateDateColumn({ type: 'datetime', precision: 6, name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6, name: 'updated_at' })
  updatedAt: Date;
}
