import { Column, Entity, PrimaryColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';

/**
 * 직접 PIN 발송 독립 정책 싱글턴 (PK id=1). rev5 §15/plan §DIRECT_PIN.
 * allocation 정책과 독립: send_enabled가 false이면 CLAIMED 전 PIN decrypt/mail I/O를 차단.
 */
@Entity('direct_pin_delivery_policy')
export class DirectPinDeliveryPolicyEntity extends BaseEntity {
  @PrimaryColumn({ type: 'int', comment: '싱글턴 PK (항상 1)' })
  id: number;

  @Column({ type: 'boolean', default: false, comment: '직접 PIN 이메일 발송 허용 여부' })
  sendEnabled: boolean;

  @Column({ type: 'int', default: 1, comment: '낙관적 잠금 version' })
  version: number;

  @Column({ type: 'int', nullable: true, comment: '최종 변경 사용자 ID' })
  updatedByUserId: number | null;

  @Column({ type: 'varchar', length: 500, nullable: true, comment: '변경 사유 (PIN 없음)' })
  reason: string | null;
}
