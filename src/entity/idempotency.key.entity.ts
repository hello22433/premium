import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

export enum IdempotencyKeyStatus {
  PROCESSING = 'PROCESSING',
  COMPLETE = 'COMPLETE',
}

@Entity('idempotency_keys')
@Unique('uq_idempotency', ['idempotencyKey', 'apiAppId', 'endpoint'])
export class IdempotencyKeyEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 64, comment: '멱등키' })
  idempotencyKey: string;

  @Column({ type: 'int', comment: 'FK) user.id (API Key 소유자)' })
  userId: number;

  @Column({ type: 'bigint', nullable: true, comment: 'FK) api_app.id (PR2a 멱등 re-key)' })
  apiAppId: string | null;

  @Column({ type: 'varchar', length: 200, comment: 'API 엔드포인트' })
  endpoint: string;

  @Column({ type: 'varchar', length: 64, comment: '요청 바디 해시 (SHA-256)' })
  requestHash: string;

  @Column({ type: 'enum', enum: IdempotencyKeyStatus, default: IdempotencyKeyStatus.PROCESSING })
  status: IdempotencyKeyStatus;

  @Column({ type: 'json', nullable: true, comment: '캐싱된 응답' })
  responseBody: any;

  @Column({ type: 'int', nullable: true, comment: '캐싱된 HTTP 상태 코드' })
  responseStatus: number | null;

  @Column({ type: 'datetime', comment: '생성 시각' })
  createdAt: Date;

  @Column({ type: 'datetime', comment: '만료 시각' })
  expiresAt: Date;
}
