import { Column, Entity, JoinColumn, OneToOne, PrimaryGeneratedColumn } from 'typeorm';
import { UserEntity } from './user.entity';

export enum ViewScopeType {
  SELF = 'SELF', // 본인 주문 + 배정된 주문
  DEPARTMENT = 'DEPARTMENT', // 같은 부서 주문 (dept_ids가 있으면 해당 부서들도 포함)
  COMPANY = 'COMPANY', // 같은 회사 전체 주문
  ALL = 'ALL', // 모든 주문 (SUPER_ADMIN용)
}

@Entity('user_view_scope')
export class UserViewScopeEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', comment: 'FK) user.id' })
  userId: number;

  @OneToOne(() => UserEntity, (user) => user.viewScope)
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Column({
    type: 'enum',
    enum: ViewScopeType,
    default: ViewScopeType.SELF,
    comment: '조회 범위 타입',
  })
  scopeType: ViewScopeType;

  @Column({
    type: 'varchar',
    length: 500,
    nullable: true,
    comment: '추가 조회 가능 부서 ID 목록 (콤마 구분, DEPARTMENT 타입일 때 사용)',
  })
  deptIds: string | null;

  @Column({ type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  @Column({ type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)', onUpdate: 'CURRENT_TIMESTAMP(6)' })
  updatedAt: Date;

  // Helper method: dept_ids를 배열로 변환
  getDeptIdList(): number[] {
    if (!this.deptIds) return [];
    return this.deptIds.split(',').map((id) => parseInt(id.trim(), 10)).filter((id) => !isNaN(id));
  }
}