import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { IOrderType } from '../order/interface/order.type';

/**
 * 주문접수 자동주문 - 멱등 기록표
 *
 * "이 접수(orderReceiptId)의 이 파일(fileIndex)에서 이 종류(type)의 주문을 만들었다"를 1행으로 남긴다.
 * 재승인/중복클릭 시 이 기록을 근거로 "이미 만들었음"을 판단해 중복 생성을 막는다.
 * UNIQUE(orderReceiptId, fileIndex, type)가 DB 레벨 최종 방어선.
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
