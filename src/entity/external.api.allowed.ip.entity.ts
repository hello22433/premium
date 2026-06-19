import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { ExternalApiAccountEntity } from './external.api.account.entity';
import { ApiAppEntity } from './api.app.entity';

@Entity('external_api_allowed_ip')
export class ExternalApiAllowedIpEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', comment: 'FK) external_api_account.id' })
  accountId: string;

  @ManyToOne(() => ExternalApiAccountEntity, (account) => account.allowedIps)
  @JoinColumn({ name: 'account_id' })
  account: ExternalApiAccountEntity;

  @Index()
  @Column({ type: 'bigint', nullable: true, comment: 'FK) api_app.id (PR2a 신구 병행)' })
  apiAppId: string | null;

  @ManyToOne(() => ApiAppEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'api_app_id' })
  apiApp?: ApiAppEntity;

  @Column({ type: 'varchar', length: 45, comment: '단일 IP (IPv4/IPv6)' })
  ipAddress: string;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '용도 설명' })
  description: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
