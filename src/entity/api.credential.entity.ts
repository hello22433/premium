import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { ApiAppEntity } from './api.app.entity';

@Entity('api_credential')
export class ApiCredentialEntity extends BaseEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Index()
  @Column({ type: 'bigint', comment: 'FK) api_app.id' })
  apiAppId: string;

  @ManyToOne(() => ApiAppEntity, (a) => a.credentials, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'api_app_id' })
  apiApp: ApiAppEntity;

  @Column({ type: 'varchar', length: 64, unique: true, comment: 'SHA-256(api_key)' })
  apiKeyHash: string;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'datetime', comment: '발급일' })
  issuedAt: Date;

  @Column({ type: 'datetime', nullable: true })
  revokedAt: Date | null;
}
