import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { IUserStatus } from '../user/interface/user.status';
import { IUserAuthority } from '../user/interface/user.authority';
import { IUserSettleCondition } from '../user/interface/user.settle.condition';
import { IUserSettleMethod } from '../user/interface/user.settle.method';
import { IUserBusinessType } from '../user/interface/user.business.type';
import { UserDiscountEntity } from './user.discount.entity';
import { UserSettlePeriodConditionEnum } from '../user/interface/user.settle.period.condition.enum';
import { OrderEntity } from './order.entity';
import { UserCompanyEntity } from './user.company.entity';

@Entity('user')
export class UserEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', nullable: true, comment: 'FK) user_company.id' })
  companyId: number | null;

  @ManyToOne(() => UserCompanyEntity, (company) => company.users)
  @JoinColumn({ name: 'company_id' })
  company: UserCompanyEntity;

  @Column({ type: 'varchar', length: 100, comment: '이메일' })
  email: string;

  @Column({ type: 'varchar', length: 256, comment: '비밀번호' })
  password: string;

  @Column({ comment: '비밀번호 초기화 여부' })
  isPasswordReset: boolean;

  @Column({ type: 'datetime', nullable: true, comment: '비밀번호 마지막 변경 일시' })
  passwordChangedAt: Date | null;

  @Column({
    type: 'varchar',
    length: 256,
    comment: '권한 ex) 최고 관리자 : SUPER_ADMIN, 운영 관리자 :OPERATION_ADMIN, 기업관리자 : CORPORATE_ADMIN',
  })
  authority: IUserAuthority;

  @Column({
    type: 'enum',
    enum: IUserStatus,
    comment: '상태 ex) 사용 : USED, 미사용 : NOT_USED, 미승인 : NOT_APPROVED, 탈퇴 : LEAVE',
  })
  status: IUserStatus;

  @Column({ type: 'varchar', length: 100, comment: '담당자 이름' })
  personName: string;

  @Column({ type: 'varchar', length: 20, comment: '담당자 연락처' })
  personPhoneNumber: string;

  @Column({ type: 'varchar', length: 100, comment: '담당자 이메일' })
  personEmail: string;

  @Column({ type: 'varchar', length: 100, comment: '담당자 코드' })
  personCode: string;

  @Column({ type: 'varchar', length: 100, default: 'GENERAL', comment: '담당자 분류, 고객 상담 내역' }) // TODO
  personCategory: string;

  @Column({
    type: 'enum',
    nullable: true,
    enum: IUserBusinessType,
    comment: '법인 유무 ex) 개인 : INDIVIDUAL, 법인 : CORPORATE',
  })
  businessType: IUserBusinessType | null;

  @Column({ type: 'varchar', length: 100, comment: '법인 등록 번호' })
  corporateNumber: string | null;

  @Column({ comment: '대표자 여부 ex) true: 기본 담당자(대표)', default: false })
  isHeadPerson: boolean;

  @Column({ type: 'varchar', nullable: true, length: 100, comment: '허용 IP' })
  ip: string | null;

  @Column({
    type: 'enum',
    enum: IUserSettleCondition,
    comment: '정산 조건 ex) 선정산 : PRE_PAYMENT, 후정산: POST_PAYMENT',
  })
  settleCondition: IUserSettleCondition;

  @Column({ type: 'varchar', length: 100, comment: '정산 방법 ex) 카드: CARD, 현금: CASH' })
  settleMethod: IUserSettleMethod;

  @Column({ type: 'varchar', length: 100, comment: '은행 명' })
  bankName: string;

  @Column({ type: 'varchar', length: 100, comment: '계좌 번호' })
  bankNumber: string;

  @Column({ type: 'varchar', length: 100, comment: '카드 명' })
  cardName: string;

  @Column({ type: 'varchar', length: 100, comment: '카드 번호' })
  cardNumber: string;

  @Column({ default: 0, comment: '잔액' })
  balance: number;

  @Column({ type: 'varchar', length: 100, default: 'S+', comment: '고객사등급' })
  businessGrade: string;

  @Column({ type: 'varchar', nullable: true, length: 20, comment: '발신 번호' })
  fromPhoneNumber: string | null;

  @Column({ type: 'enum', enum: UserSettlePeriodConditionEnum, nullable: true, comment: '정산 기준 지정 월 조건' })
  settlePeriodCondition: UserSettlePeriodConditionEnum | null;

  @Column({ type: 'int', nullable: true, comment: '정산 기준 일 수' })
  settlePeriodCount: number | null;

  @Column({ type: 'int', default: 0, comment: '전체 주문 완료 금액' })
  allSettleAmount: number;

  @Column({ type: 'int', default: 0, comment: '서비스 금액' })
  serviceAmount: number;

  @Column({ type: 'int', default: 0, comment: '중복번호제어 (0: 중복허용, 1~10: 해당 개수만큼 중복 허용)' })
  duplicatePhoneLimit: number;

  @Column({ type: 'varchar', nullable: true, length: 1024, comment: '페이지 접근 허용 list' })
  authorityList: string | null;

  @OneToMany(() => OrderEntity, (order) => order.user)
  orders: OrderEntity[];

  @OneToMany(() => UserDiscountEntity, (userDisCount) => userDisCount.user)
  userDiscounts: UserDiscountEntity[];
}
