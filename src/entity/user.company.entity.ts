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

  /**
   * @deprecated PR1+ wallet_account.deposit_balance 사용. PR5에서 DROP 예정.
   */
  @Column({
    type: 'int',
    default: 0,
    comment: '선충전잔액 (회사 레벨) (DEPRECATED — wallet_account.deposit_balance 사용)',
  })
  balance: number;

  /**
   * @deprecated PR1+ 폐지. ACCOUNT/COMPANY 분기 없이 모든 user를 `company-${id}` 공유 settlement_code로 통합.
   * PR5에서 DROP 예정.
   */
  @Column({
    type: 'varchar',
    length: 20,
    default: 'COMPANY',
    comment: '선충전 관리 방식 (DEPRECATED — settlement_code로 통합)',
  })
  balanceManagementType: 'COMPANY' | 'ACCOUNT';

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
