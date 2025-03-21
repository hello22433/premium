import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { UserEntity } from './user.entity';

@Entity('user_task_history')
export class UserTaskHistoryEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) user.id' })
  userId: number;

  @Column({ type: 'text', nullable: true })
  content: string | null;

  @Column({ comment: 'FK) user.id (관리자)' })
  adminUserId: number;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'admin_user_id' })
  adminUser?: UserEntity;
}
