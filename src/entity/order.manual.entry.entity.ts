import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { OrderEntity } from './order.entity';

@Entity('order_manual_entry')
export class OrderManualEntryEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) order.id' })
  orderId: number;

  @Column({ type: 'int', comment: '행 순서 (0-based)' })
  rowIndex: number;

  @Column({ type: 'varchar', length: 128, comment: '전화번호 (암호화)' })
  phoneNumber: string;

  @Column({ type: 'int', comment: '발송금액' })
  sendAmount: number;

  @Column({ type: 'varchar', length: 200, nullable: true, comment: '대치문자 1' })
  replaceCharacter1: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, comment: '대치문자 2' })
  replaceCharacter2: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, comment: '대치문자 3' })
  replaceCharacter3: string | null;

  @Column({
    type: 'varchar',
    length: 500,
    nullable: true,
    comment: '수신자별 운영자 메모 (고객 미노출, 치환 대상 아님)',
  })
  memo: string | null;

  @ManyToOne(() => OrderEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'order_id' })
  order: OrderEntity;
}
