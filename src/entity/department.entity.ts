import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { UserCompanyEntity } from './user.company.entity';
import { UserEntity } from './user.entity';

@Entity('department')
export class DepartmentEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', comment: 'FK) user_company.id' })
  companyId: number;

  @ManyToOne(() => UserCompanyEntity)
  @JoinColumn({ name: 'company_id' })
  company: UserCompanyEntity;

  @Column({ type: 'varchar', length: 100, comment: '부서명' })
  name: string;

  @OneToMany(() => UserEntity, (user) => user.department)
  users: UserEntity[];
}