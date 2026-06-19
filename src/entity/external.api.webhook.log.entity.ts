import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { ExternalApiAccountEntity } from './external.api.account.entity';

@Entity('external_api_webhook_log')
export class ExternalApiWebhookLogEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', comment: 'FK) external_api_account.id' })
  externalApiAccountId: string;

  @ManyToOne(() => ExternalApiAccountEntity)
  @JoinColumn({ name: 'external_api_account_id' })
  account: ExternalApiAccountEntity;

  @Index()
  @Column({ type: 'bigint', nullable: true, comment: 'FK) api_app.id (PR2a 신구 병행)' })
  apiAppId: string | null;

  @Column({ type: 'bigint', nullable: true, comment: 'FK) order_delivery.id' })
  orderDeliveryId: number | null;

  @Column({ type: 'varchar', length: 32, comment: '이벤트 종류' })
  eventType: string;

  @Index()
  @Column({ type: 'varchar', length: 64, comment: '이벤트 UUID' })
  eventId: string;

  @Column({ type: 'varchar', length: 512, comment: '발송 URL 스냅샷' })
  requestUrl: string;

  @Column({ type: 'text', comment: 'JSON 페이로드' })
  requestBody: string;

  @Column({ type: 'int', nullable: true, comment: 'HTTP status' })
  responseStatus: number | null;

  @Column({ type: 'text', nullable: true, comment: '응답 본문 (최대 2KB 절단)' })
  responseBody: string | null;

  @Column({ type: 'text', nullable: true, comment: '예외 메시지' })
  errorMessage: string | null;

  @Column({ type: 'boolean', comment: '2xx 여부' })
  isSuccess: boolean;

  @Column({ type: 'int', nullable: true, comment: '소요 시간 (ms)' })
  responseTimeMs: number | null;

  @CreateDateColumn()
  createdAt: Date;
}
