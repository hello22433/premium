import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { UserEntity } from './user.entity';
import { ApiCredentialEntity } from './api.credential.entity';
import { ExternalApiAllowedIpEntity } from './external.api.allowed.ip.entity';

@Entity('api_app')
export class ApiAppEntity extends BaseEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Index()
  @Column({ type: 'int', comment: 'FK) user.id (단순모드 차감대상)' })
  defaultBillingUserId: number;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'default_billing_user_id' })
  defaultBillingUser?: UserEntity;

  @Column({
    type: 'bigint',
    nullable: true,
    unique: true,
    comment: 'FK) external_api_account.id (account↔app 1:1)',
  })
  sourceAccountId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '운영 식별' })
  name: string | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'boolean', default: false, comment: 'SSG 주문 승인' })
  ssgEnabled: boolean;

  @Column({ type: 'int', nullable: true, comment: '재발송 최대(NULL=시스템기본)' })
  resendMaxCount: number | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  cancelWebhookUrl: string | null;

  @Column({ type: 'boolean', default: false })
  cancelWebhookEnabled: boolean;

  @Column({
    type: 'boolean',
    default: false,
    comment: '매핑 필수 모드(true면 externalCustomerId 없는 상품조회/주문 거절, default fallback 차단)',
  })
  requireExternalCustomerId: boolean;

  @OneToMany(() => ApiCredentialEntity, (c) => c.apiApp)
  credentials: ApiCredentialEntity[];

  @OneToMany(() => ExternalApiAllowedIpEntity, (ip) => ip.apiApp)
  allowedIps?: ExternalApiAllowedIpEntity[];
}
