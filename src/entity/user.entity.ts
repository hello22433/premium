import { Column, Entity, JoinColumn, ManyToOne, OneToMany, OneToOne, PrimaryGeneratedColumn } from 'typeorm';
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
import { DepartmentEntity } from './department.entity';
import { UserViewScopeEntity } from './user.view.scope.entity';
import { CompanyType } from '../common/domain/company.type';
import { LoginVerifyMethod } from '../user/interface/login.verify.method';

@Entity('user')
export class UserEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', nullable: true, comment: 'FK) user_company.id' })
  companyId: number | null;

  @ManyToOne(() => UserCompanyEntity, (company) => company.users)
  @JoinColumn({ name: 'company_id' })
  company: UserCompanyEntity;

  @Column({
    type: 'varchar',
    length: 50,
    default: '',
    comment: 'wallet_account.owner_id 매핑 키 (default: company-{companyId})',
  })
  settlementCode: string;

  @Column({ type: 'int', nullable: true, comment: 'FK) department.id' })
  departmentId: number | null;

  @ManyToOne(() => DepartmentEntity, (department) => department.users)
  @JoinColumn({ name: 'department_id' })
  department: DepartmentEntity;

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

  @Column({ type: 'varchar', length: 500, comment: '담당자 이메일 (쉼표 구분으로 여러 개 저장 가능)' })
  personEmail: string;

  @Column({ type: 'varchar', length: 100, comment: '담당자 코드' })
  personCode: string;

  @Column({ type: 'varchar', length: 100, default: 'GENERAL', comment: '담당자 분류, 고객 상담 내역' }) // TODO
  personCategory: string;

  @Column({
    type: 'varchar',
    length: 10,
    default: LoginVerifyMethod.EMAIL,
    comment: '로그인 인증 방식 (EMAIL, PHONE)',
  })
  loginVerifyMethod: LoginVerifyMethod;

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

  @Column({ type: 'int', default: 0, comment: '연속 로그인 실패 횟수' })
  loginFailCount: number;

  @Column({ type: 'boolean', default: false, comment: '로그인 영구 잠금 여부 (관리자 해제)' })
  isLoginLocked: boolean;

  @Column({ type: 'datetime', nullable: true, comment: '잠금 발생 시각 (감사용)' })
  lockedAt: Date | null;

  @Column({
    type: 'datetime',
    comment: '마지막 활동 시각 (로그인 OR 외부 API 인증). 휴면 판정 기준 — last_login 아님',
  })
  lastActivityAt: Date;

  @Column({ type: 'datetime', nullable: true, comment: '휴면(NOT_USED) 전환 시각. 탈퇴 +6개월 계산 기준' })
  suspendedAt: Date | null;

  @Column({ type: 'datetime', nullable: true, comment: '탈퇴(LEAVE) 전환 시각. 익명화 +6개월 계산 기준' })
  withdrawnAt: Date | null;

  @Column({ type: 'datetime', nullable: true, comment: 'PII 익명화 처리 시각. 익명화 멱등성 게이트 (NULL=미처리)' })
  anonymizedAt: Date | null;

  /**
   * @deprecated PR1+ wallet_account.settle_condition 사용. settlement_code 단위 정책.
   * PR5 에서 DROP 예정. legacy display fallback only.
   */
  @Column({
    type: 'enum',
    enum: IUserSettleCondition,
    comment: '정산 조건 (DEPRECATED — wallet_account.settle_condition 사용)',
  })
  settleCondition: IUserSettleCondition;

  /**
   * @deprecated PR1+ wallet_account.settle_method 사용. settlement_code 단위 정책.
   * PR5 에서 DROP 예정.
   */
  @Column({
    type: 'varchar',
    length: 100,
    comment: '정산 방법 (DEPRECATED — wallet_account.settle_method 사용)',
  })
  settleMethod: IUserSettleMethod;

  @Column({ type: 'varchar', length: 100, comment: '은행 명' })
  bankName: string;

  @Column({ type: 'varchar', length: 100, comment: '계좌 번호' })
  bankNumber: string;

  @Column({ type: 'varchar', length: 100, comment: '카드 명' })
  cardName: string;

  @Column({ type: 'varchar', length: 100, comment: '카드 번호' })
  cardNumber: string;

  /**
   * @deprecated PR1+ wallet_account.deposit_balance 사용. PR5에서 DROP 예정.
   * 신규 코드에서는 WalletAccountResolverService로 settlement_code 단위 잔액을 조회한다.
   */
  @Column({ default: 0, comment: '잔액 (DEPRECATED — wallet_account.deposit_balance 사용)' })
  balance: number;

  @Column({ type: 'varchar', length: 100, default: 'S+', comment: '고객사등급' })
  businessGrade: string;

  /** @deprecated SoT = order_from_definition. cutover 호환 mirror. 별도 PR 에서 DROP 예정. */
  @Column({ type: 'varchar', nullable: true, length: 20, comment: '발신 번호 (deprecated mirror, SoT=order_from_definition)' })
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

  /**
   * @deprecated external_api_account 테이블로 이관됨. 안정화 후 별도 마이그레이션에서 DROP 예정.
   * 신규 코드에서는 ExternalApiAccountEntity.apiKeyHash를 사용한다.
   */
  @Column({
    type: 'varchar',
    length: 64,
    nullable: true,
    unique: true,
    comment: '외부 API 키 (SHA-256 해시) - DEPRECATED',
  })
  apiKeyHash: string | null;

  @Column({
    type: 'varchar',
    length: 100,
    default: 'ALIM_TALK,SMS,EMAIL',
    comment: '허용 발신수단 목록 (쉼표 구분: ALIM_TALK,SMS,EMAIL)',
  })
  allowedSendMethods: string;

  @Column({
    type: 'varchar',
    length: 20,
    default: CompanyType.ENMAD,
    comment: '기본 문서 양식 (ENMAD: 모바일이앤엠애드, SYSCUSS: 시스커스)',
  })
  documentCompanyType: CompanyType;

  @OneToMany(() => OrderEntity, (order) => order.user)
  orders: OrderEntity[];

  @OneToMany(() => OrderEntity, (order) => order.clientUser)
  clientOrders: OrderEntity[];

  @OneToMany(() => UserDiscountEntity, (userDisCount) => userDisCount.user)
  userDiscounts: UserDiscountEntity[];

  @OneToOne(() => UserViewScopeEntity, (viewScope) => viewScope.user)
  viewScope: UserViewScopeEntity;
}
