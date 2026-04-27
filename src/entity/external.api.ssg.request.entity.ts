import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { ExternalApiAccountEntity } from './external.api.account.entity';
import { UserEntity } from './user.entity';
import { IExternalApiSsgRequestStatus } from '../external_api/interface/external.api.ssg.request.status';

@Entity('external_api_ssg_request')
export class ExternalApiSsgRequestEntity extends BaseEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', comment: 'FK) external_api_account.id' })
  accountId: string;

  @ManyToOne(() => ExternalApiAccountEntity)
  @JoinColumn({ name: 'account_id' })
  account: ExternalApiAccountEntity;

  @Column({ type: 'int', comment: 'FK) user.id (요청자)' })
  requestedByUserId: number;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'requested_by_user_id' })
  requestedByUser: UserEntity;

  @Column({ type: 'varchar', length: 500, comment: '요청 사유' })
  reason: string;

  @Column({ type: 'enum', enum: IExternalApiSsgRequestStatus, default: IExternalApiSsgRequestStatus.PENDING })
  status: IExternalApiSsgRequestStatus;

  @Column({ type: 'int', nullable: true, comment: 'FK) user.id (승인/거부 어드민)' })
  decidedByUserId: number | null;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'decided_by_user_id' })
  decidedByUser: UserEntity | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  decidedAt: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true, comment: '승인/거부 사유' })
  decisionNote: string | null;
}
