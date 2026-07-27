import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { IOrderType } from '../order/interface/order.type';

/**
 * 주문접수 자동주문 - 멱등 기록표
 *
 * "이 접수(orderReceiptId)의 이 파일(fileIndex)에서 이 종류(type)의 주문을 만들었다"를 1행으로 남긴다.
 * 재승인/중복클릭 시 이 기록을 근거로 "이미 만들었음"을 판단해 중복 생성을 막는다.
 * UNIQUE(orderReceiptId, fileIndex, type)가 DB 레벨 최종 방어선.
 *
 * ⚠️ append-only / hard-delete 전용 표 — softRemove 금지(리뷰 #17):
 *   BaseEntity의 deletedAt(soft-delete)이 상속되지만, UNIQUE 인덱스에는 deletedAt이 포함되지 않는다.
 *   MySQL은 soft-delete된 행도 물리적으로 남겨 UNIQUE에 그대로 잡으므로, 이 표를 softRemove하면
 *   같은 (orderReceiptId, fileIndex, type)의 재삽입이 영구 차단된다(재승인 불가). 현재 softRemove 호출자는
 *   없어 잠복 상태이며(도달불가), 실패 모드도 "차단"이라 안전하다. 만약 삭제가 필요해지면 반드시 물리 삭제(delete)를
 *   쓸 것. soft-delete를 살리려면 UNIQUE를 deletedAt 포함 부분유니크(MySQL은 생성 컬럼 필요)로 재설계해야 한다.
 */
@Entity('order_receipt_generated_order')
@Unique('uq_receipt_file_type', ['orderReceiptId', 'fileIndex', 'type'])
export class OrderReceiptGeneratedOrderEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) order_receipt.id, 자동주문을 유발한 접수 id' })
  orderReceiptId: number;

  @Column({ type: 'int', comment: 'filePath(콤마구분) 내 파일 순번 (0부터)' })
  fileIndex: number;

  @Column({ comment: 'FK) order.id, 이 파일에서 생성된 임시(TEMP) 주문 id' })
  orderId: number;

  @Column({
    type: 'varchar',
    length: 20,
    comment: '생성된 주문 종류 ex) GENERAL, SSG',
  })
  type: IOrderType;
}
