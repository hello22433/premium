import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { UserEntity } from './user.entity';
import { DepartmentEntity } from './department.entity';

@Entity('user_company')
export class UserCompanyEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 100, comment: '사업자명' })
  businessName: string;

  @Column({ type: 'varchar', length: 100, unique: true, comment: '사업자등록번호' })
  businessNumber: string;

  @Column({ type: 'varchar', length: 255, nullable: true, comment: '사업자주소' })
  businessAddress: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true, comment: '사업자연락처' })
  businessPhoneNumber: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '업태' })
  industryType: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '종목' })
  industryItem: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '정산방법 ex) 카드: CARD, 현금: CASH' })
  settleMethod: string | null;

  @Column({ type: 'int', default: 0, comment: '여신 한도' })
  maximumLimit: number;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '은행명' })
  bankName: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '계좌번호' })
  bankNumber: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '카드사명' })
  cardName: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '카드번호' })
  cardNumber: string | null;

  @OneToMany(() => UserEntity, (user) => user.company)
  users: UserEntity[];

  @OneToMany(() => DepartmentEntity, (department) => department.company)
  departments: DepartmentEntity[];
}