import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { UserEntity } from './user.entity';

@Entity('password_policy')
export class PasswordPolicyEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', comment: '비밀번호 만료 기간 (일 단위)' })
  passwordExpiryDays: number;

  @Column({ type: 'int', nullable: true, comment: '설정한 관리자 ID' })
  createdByUserId: number | null;

  @ManyToOne(() => UserEntity, { nullable: true })
  @JoinColumn({ name: 'created_by_user_id' })
  createdByUser: UserEntity | null;
}
