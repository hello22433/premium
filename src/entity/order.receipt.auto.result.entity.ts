import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';

/**
 * 주문접수 자동주문 - 검산 리포트 스냅샷
 *
 * 승인(COMMIT) 시점에 생성된 리포트(파일별 주문/blocked/검산)를 통째로 JSON 직렬화해 1행으로 저장한다.
 * 재승인/결과 재조회 시 재계산하지 않고 이 스냅샷을 그대로 반환한다.
 * (SSG 예약창은 시간의존적이라 나중에 다시 계산하면 결과가 달라질 수 있으므로, 승인 당시의 사실을 고정 보관)
 */
@Entity('order_receipt_auto_result')
export class OrderReceiptAutoResultEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true, comment: 'FK) order_receipt.id, 접수당 리포트 1건' })
  orderReceiptId: number;

  @Column({
    type: 'longtext',
    comment: '리포트 전체(파일/주문/blocked/reconciliation) JSON 직렬화 스냅샷',
  })
  resultJson: string;

  @Column({
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '승인 당시 첨부(filePath) 해시(sha256). 재승인 시 현재 첨부와 다르면 스냅샷 반환 대신 400',
  })
  filePathHash: string | null;

  @Column({ type: 'datetime', comment: '리포트 생성(=승인 커밋) 시각' })
  generatedAt: Date;
}
