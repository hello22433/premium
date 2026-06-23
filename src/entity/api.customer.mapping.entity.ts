import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { ApiAppEntity } from './api.app.entity';
import { UserEntity } from './user.entity';

/**
 * 외부 API 3계층 매핑모드(PR2).
 * (apiAppId, externalCustomerId) → billingUserId 매핑.
 *
 * - externalCustomerId 는 전역 유니크가 아니라 **api_app 내에서만** 유니크.
 *   (WiseAd/client-1 ≠ ExternalCorp/client-1)
 * - 유니크는 active-only: soft-delete(deleted_at IS NOT NULL) 행은 유니크 대상에서 제외해
 *   삭제 후 동일 externalCustomerId 재등록을 허용한다.
 *   → DB 레벨에서 generated column `active_key`(= CASE WHEN deleted_at IS NULL THEN
 *     external_customer_id ELSE NULL END) + UNIQUE(api_app_id, active_key) 로 구현
 *     (sql/migrations/20260622_pr2_customer_mapping.sql). MySQL 은 unique 인덱스에서 NULL 을
 *     distinct 로 취급하므로 삭제 행(active_key=NULL)끼리는 충돌하지 않는다.
 * - active_key 는 DB 생성 컬럼이라 애플리케이션에서 쓰지 않는다(insert/update/select 제외).
 */
@Entity('api_customer_mapping')
export class ApiCustomerMappingEntity extends BaseEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Index()
  @Column({ type: 'bigint', comment: 'FK) api_app.id (외부 API 호출주체)' })
  apiAppId: string;

  @ManyToOne(() => ApiAppEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'api_app_id' })
  apiApp?: ApiAppEntity;

  @Column({ type: 'varchar', length: 191, comment: '외부 고객 식별자 (api_app 내 유니크)' })
  externalCustomerId: string;

  @Index()
  @Column({ type: 'int', comment: 'FK) user.id (매핑 차감대상 billing user)' })
  billingUserId: number;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'billing_user_id' })
  billingUser?: UserEntity;
}
