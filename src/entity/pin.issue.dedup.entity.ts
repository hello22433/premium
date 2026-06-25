import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * PIN 발급 중복 방지 dedup 테이블
 *
 * 같은 transactionId로 동시에 issue()가 두 번 호출되는 상황을
 * DB unique 제약으로 차단하기 위한 테이블.
 *
 * - CULTURELAND은 0099 복구 프로토콜(동일 trId 재요청)을 위해 dedup 대상에서 제외됨
 * - 실패 시에도 row를 남겨두고, fail-history 재발송이 R+i suffix로 새 transactionId를
 *   만들어 자연스럽게 재시도 가능하도록 설계
 */
@Entity('pin_issue_dedup')
export class PinIssueDedupEntity {
  @PrimaryColumn({
    type: 'varchar',
    length: 64,
    name: 'transaction_id',
    comment: '발급 거래번호 (orderDelivery.transactionId)',
  })
  transactionId: string;

  @Index('idx_order_delivery_id')
  @Column({ type: 'int', name: 'order_delivery_id', comment: 'FK) order_delivery.id' })
  orderDeliveryId: number;

  @Column({ type: 'varchar', length: 32, name: 'partner_type', comment: '협력사 타입' })
  partnerType: string;

  @Column({
    type: 'varchar',
    length: 64,
    name: 'bar_code',
    nullable: true,
    comment: '발급된 PIN (성공 시 기록, 감사용)',
  })
  barCode: string | null;

  @Column({
    type: 'enum',
    enum: ['DEDUP', 'CHECK_API', 'HISTORY_LOG', 'FRESH_ISSUE'],
    name: 'recovered_from',
    default: 'FRESH_ISSUE',
    comment: 'PIN 복구 경로 (감사용)',
  })
  recoveredFrom: 'DEDUP' | 'CHECK_API' | 'HISTORY_LOG' | 'FRESH_ISSUE';

  @Column({ type: 'datetime', precision: 6, name: 'issued_at', comment: 'issue() 진입 시각' })
  issuedAt: Date;
}
