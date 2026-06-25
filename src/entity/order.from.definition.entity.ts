import { BaseEntity } from '../common/entity/base.entity';
import {
  OrderFromDefinitionType,
  OrderFromRequestStatus,
  TelecomCertType,
} from '../order_from/interface/order.from.definition.type';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('order_from_definition')
export class OrderFromDefinitionEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 100, comment: '핸드폰: PHONE, 이메일 :EMAIL' })
  type: OrderFromDefinitionType;

  @Column({ type: 'int', comment: 'FK) user.id' })
  userId: number;

  @Column({ type: 'varchar', length: 100, comment: '핸드폰 혹은 이메일 발신 정보' })
  from: string;

  @Column({
    type: 'enum',
    enum: OrderFromRequestStatus,
    default: OrderFromRequestStatus.PENDING,
    nullable: true,
    comment: 'PENDING - 요청중, APPROVED - 승인, REJECTED - 거절',
  })
  requestStatus: OrderFromRequestStatus;

  @Column({ type: 'boolean', default: false, comment: '기본 발신번호 여부' })
  isDefault: boolean;

  @Column({
    type: 'enum',
    enum: TelecomCertType,
    nullable: true,
    comment: 'FILE_ATTACHED - 파일첨부, PRE_DELIVERED - 기전달',
  })
  telecomCertType: TelecomCertType | null;

  @Column({ type: 'varchar', length: 500, nullable: true, comment: '통신이용증명원 파일 S3 URL' })
  telecomCertFile: string | null;

  @Column({ type: 'text', nullable: true, comment: '관리자 거절 사유' })
  rejectReason: string | null;
}
