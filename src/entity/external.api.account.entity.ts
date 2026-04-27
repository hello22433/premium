import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { UserEntity } from './user.entity';
import { ExternalApiAllowedIpEntity } from './external.api.allowed.ip.entity';

@Entity('external_api_account')
export class ExternalApiAccountEntity extends BaseEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'int', comment: 'FK) user.id' })
  userId: number;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Column({ type: 'varchar', length: 64, unique: true, comment: 'SHA-256(api_key)' })
  apiKeyHash: string;

  @Column({ type: 'boolean', default: true, comment: '활성 여부' })
  isActive: boolean;

  @Column({ type: 'boolean', default: false, comment: 'SSG 주문 승인 여부' })
  ssgEnabled: boolean;

  @Column({ type: 'int', nullable: true, comment: '재발송 최대 횟수 (NULL=시스템 기본값)' })
  resendMaxCount: number | null;

  @OneToMany(() => ExternalApiAllowedIpEntity, (ip) => ip.account)
  allowedIps: ExternalApiAllowedIpEntity[];
}
