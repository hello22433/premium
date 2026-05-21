import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { PointPolicyEffect, PointPolicyOwnerType, PointPolicyScopeType } from '../wallet/interface/point-policy-scope';

@Entity('point_policy_rule')
@Index('idx_point_policy_owner', ['ownerType', 'ownerId'])
@Index('idx_point_policy_scope', ['scopeType', 'scopeId', 'scopeCode'])
export class PointPolicyRuleEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 20, comment: 'COMMON | COMPANY | POINT_GRANT' })
  ownerType: PointPolicyOwnerType;

  @Column({ type: 'bigint', nullable: true, comment: 'owner_type=COMMON이면 NULL' })
  ownerId: string | null;

  @Column({ type: 'varchar', length: 10, comment: 'ALLOW | DENY' })
  effect: PointPolicyEffect;

  @Column({
    type: 'varchar',
    length: 30,
    comment: 'PRODUCT | BRAND | CATEGORY | PARTNER_COMPANY | ORDER_TYPE',
  })
  scopeType: PointPolicyScopeType;

  @Column({ type: 'bigint', nullable: true })
  scopeId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  scopeCode: string | null;

  @Column({ type: 'tinyint', width: 1, default: 1 })
  active: number;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
