import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { UserEntity } from './user.entity';
import { UserSyncProductEventMappingEntity } from './user.sync.product.event.mapping.entity';
import { IUserSyncProductStatus } from '../user_sync_product/interface/user.sync.product.status';

@Entity('user_sync_product_event')
export class UserSyncProductEventEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) 고객사 user.id' })
  businessUserId: number;

  @Column({ comment: '담당자 이름' })
  personName: string;

  @Column({ comment: '연동 이벤트 명' })
  name: string;

  @Column({ comment: '이벤트 코드' })
  code: string;

  @Column({ comment: '연락처' })
  phone: string;

  @Column({ comment: '이메일' })
  email: string;

  @Column({ comment: '운영 상태 ex) ACTIVE: 사용, STOPPED: 일시중지, CLOSED: 종료' })
  status: IUserSyncProductStatus;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'business_user_id' })
  businessUser: UserEntity;

  @Column({ comment: 'FK) 관리자 user.id' })
  adminUserId: number;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'admin_user_id' })
  adminUser: UserEntity;

  @OneToMany(
    () => UserSyncProductEventMappingEntity,
    (userSyncProductEventMapping) => userSyncProductEventMapping.userSyncProductEvent,
    {
      createForeignKeyConstraints: false,
    },
  )
  userSyncProductEventMappings?: UserSyncProductEventMappingEntity[];
}
