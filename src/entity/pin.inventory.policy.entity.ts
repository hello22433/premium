import { Column, Entity, PrimaryColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';

/**
 * 도메인 싱글턴 정책 행 (PK id=1). rev5 §4.10.
 * applications_open: 외부 API 신청에만 적용
 * allocation_enabled: 모든 채널의 신규 PIN 할당에 적용
 */
@Entity('pin_inventory_policy')
export class PinInventoryPolicyEntity extends BaseEntity {
  @PrimaryColumn({ type: 'int', comment: '싱글턴 PK (항상 1)' })
  id: number;

  @Column({ type: 'boolean', default: false, comment: '신규 신청 접수 가능 여부' })
  applicationsOpen: boolean;

  @Column({ type: 'boolean', default: false, comment: '모든 채널의 신규 PIN 할당 가능 여부' })
  allocationEnabled: boolean;

  @Column({ type: 'int', default: 1, comment: '운영 토글 낙관적 잠금' })
  version: number;

  @Column({ type: 'int', nullable: true, comment: '최종 변경 사용자 ID' })
  updatedByUserId: number | null;
}
