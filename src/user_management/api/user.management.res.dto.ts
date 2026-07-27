import { UserManagementViewDto } from './dto/user.management.view.dto';
import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserManagementNameViewDto } from './dto/user.management.name.view.dto';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserStatus } from '../../user/interface/user.status';
import { IUserSettleCondition } from '../../user/interface/user.settle.condition';
import { IUserSettleMethod } from '../../user/interface/user.settle.method';
import { IUserBusinessType } from '../../user/interface/user.business.type';
import { UserSettlePeriodConditionEnum } from '../../user/interface/user.settle.period.condition.enum';
import { ViewScopeType } from '../../entity/user.view.scope.entity';
import { CompanyType } from '../../common/domain/company.type';
import { LoginVerifyMethod } from '../../user/interface/login.verify.method';

export class UserManagementGetNameListResDto {
  @ApiProperty({
    description: 'list',
  })
  list: UserManagementNameViewDto[];
}

export class UserManagementGetDetailResDto {
  @ApiProperty({
    description: 'user id',
  })
  id: number;

  @ApiProperty({
    description: 'user email',
  })
  email: string;

  @ApiProperty({
    description: '비밀번호 초기화 여부',
  })
  isPasswordReset: boolean;

  @ApiProperty({
    description: '권한 ex) 최고 관리자 : SUPER_ADMIN, 운영 관리자 :OPERATION_ADMIN, 기업관리자 : CORPORATE_ADMIN',
  })
  authority: IUserAuthority;

  @ApiProperty({
    description: '상태 ex) 사용 : USED, 미사용 : NOT_USED, 미승인 : NOT_APPROVED, 탈퇴 : LEAVE',
  })
  status: IUserStatus;

  @ApiProperty({
    description: '로그인 영구 잠금 여부 (5회 실패 잠금)',
  })
  isLoginLocked: boolean;

  @ApiProperty({
    description: '잠금 발생 시각 (UTC, ISO) — 표시용',
    nullable: true,
  })
  lockedAt: string | null;

  @ApiProperty({
    description: '담당자 이름',
  })
  personName: string;

  @ApiProperty({
    description: '담당자 연락처',
  })
  personPhoneNumber: string;

  @ApiProperty({
    description: '담당자 이메일',
  })
  personEmail: string;

  @ApiProperty({
    description: '담당자 코드',
  })
  personCode: string;

  @ApiProperty({
    description: '담당자 분류',
  })
  personCategory: string;

  @ApiProperty({
    description: '법인 등록 번호',
  })
  corporateNumber: string | null;

  @ApiProperty({
    description: '법인 유무 ex) 개인 : INDIVIDUAL, 법인 : CORPORATE',
  })
  businessType: IUserBusinessType | null;

  @ApiProperty({
    description: '사업자 등록 번호',
  })
  businessNumber: string;

  @ApiProperty({
    description: '사업자 명',
  })
  businessName: string;

  @ApiProperty({
    description: '사업자 주소',
  })
  businessAddress: string;

  @ApiProperty({
    description: '사업자 연락처',
  })
  businessPhoneNumber: string;

  @ApiProperty({
    description: '허용 ip',
  })
  ip: string | null;

  @ApiProperty({
    description: '정산 조건 ex) 선정산 : PRE_PAYMENT, 후정산: POST_PAYMENT',
  })
  settleCondition: IUserSettleCondition;

  @ApiProperty({
    description: '정산 방법 ex) 카드: CARD, 현금: CASH',
  })
  settleMethod: IUserSettleMethod;

  @ApiProperty({
    description: '최대 서비스 한도 가격',
  })
  maximumLimit: number;

  @ApiProperty({
    description: '은행 명',
  })
  bankName: string;

  @ApiProperty({
    description: '계좌 번호',
  })
  bankNumber: string;

  @ApiProperty({
    description: '카드 명',
  })
  cardName: string;

  @ApiProperty({
    description: '카드 번호',
  })
  cardNumber: string;

  @ApiProperty({
    description: '잔액',
  })
  balance: number;

  @ApiProperty({
    description: '발신 번호',
  })
  fromPhoneNumber: string | null;

  @ApiProperty({
    description:
      '정산 조건 월 타입 ex) CURRENT_MONTH: 당월, NEXT_MONTH: 익월, NEXT_MONTH_AFTER: 익익월, DELIVERY_DATE: 발송일',
  })
  settlePeriodCondition: UserSettlePeriodConditionEnum | null;

  @ApiProperty({
    description: '발송 조건 일',
  })
  settlePeriodCount: number | null;

  @ApiProperty({
    description: '중복번호제어 (0: 중복허용, 1~10: 해당 개수만큼 중복 허용)',
  })
  duplicatePhoneLimit: number;

  @ApiProperty({
    description: 'MMS 발신번호 선택목록에서 시스템 기본번호(1644-3614) 숨김 여부',
  })
  hideSystemFromPhone: boolean;

  @ApiProperty({
    description: '권한 허용 list',
  })
  authorityList: string[];

  @ApiProperty({
    description: '업태',
  })
  industryType: string | null;

  @ApiProperty({
    description: '종목',
  })
  industryItem: string | null;

  @ApiProperty({
    description: '기본 문서 양식',
    enum: CompanyType,
  })
  documentCompanyType: CompanyType;

  @ApiProperty({
    description: '소속 회사 ID',
    nullable: true,
  })
  companyId: number | null;

  @ApiProperty({
    description: '소속 회사 정보',
    nullable: true,
  })
  company: UserCompanyInfoDto | null;

  @ApiPropertyOptional({
    description: '소속 부서 ID',
    nullable: true,
  })
  departmentId?: number | null;

  @ApiPropertyOptional({
    description: '소속 부서 정보',
    nullable: true,
  })
  department?: UserDepartmentInfoDto | null;

  @ApiPropertyOptional({
    description: '조회 범위 설정',
    nullable: true,
  })
  viewScope?: UserViewScopeInfoDto | null;

  @ApiProperty({
    description: '허용 발신수단 목록 (ALIM_TALK, MMS, EMAIL)',
    example: ['ALIM_TALK', 'MMS', 'EMAIL'],
  })
  allowedSendMethods: string[];

  @ApiProperty({
    description: '로그인 인증 방식 (EMAIL: 이메일 인증, PHONE: 휴대번호 인증)',
    enum: LoginVerifyMethod,
  })
  loginVerifyMethod: LoginVerifyMethod;

  @ApiProperty({
    description: '대상 계정 기준 잔여 발송 한도 (회사/wallet 과금 계정 기준)',
  })
  remainServiceAmount: number;

  @ApiProperty({
    description: '대상 계정 기준 신용초과금 (잔여 한도가 음수일 때의 초과액, 0 이상)',
  })
  creditExcessAmount: number;

  @ApiProperty({
    description:
      '대상 계정 기준 현재 여신 사용액 (wallet_account.credit_used_amount, 원 단위 0 이상). 여신 이력의 사용액 누계 최신값과 정합. wallet 미부여 계정은 0.',
  })
  creditUsedAmount: number;
}

export class UserDepartmentInfoDto {
  @ApiProperty({ description: '부서 ID' })
  id: number;

  @ApiProperty({ description: '부서명' })
  name: string;
}

export class UserViewScopeInfoDto {
  @ApiProperty({ description: '조회 범위 타입', enum: ViewScopeType })
  scopeType: ViewScopeType;

  @ApiProperty({ description: '추가 조회 가능 부서 ID 목록', type: [Number] })
  deptIds: number[];
}

export class UserCompanyInfoDto {
  @ApiProperty({ description: '회사 ID' })
  id: number;

  @ApiProperty({ description: '사업자명' })
  businessName: string;

  @ApiProperty({ description: '사업자등록번호' })
  businessNumber: string;

  @ApiProperty({ description: '여신 한도' })
  maximumLimit: number;

  @ApiProperty({ description: '선충전잔액 (회사 레벨)' })
  balance: number;

  @ApiProperty({ description: '선충전 관리 방식: COMPANY(회사별 공유), ACCOUNT(계정별 개별)' })
  balanceManagementType: 'COMPANY' | 'ACCOUNT';
}

export class UserManagementGetListResDto extends GetListResDto {
  @ApiProperty({
    description: '계정 list',
  })
  list: UserManagementViewDto[];
}

export class UserManagementBalanceViewDto {
  @ApiProperty({ description: '현재 잔액' })
  balance: number;
}

export class BalanceHistoryItemDto {
  @ApiProperty({ description: '이력 ID' })
  id: number;

  @ApiProperty({ description: '일시 (yyyy-MM-ddTHH:mm:ss)' })
  createdAt: string;

  @ApiProperty({ description: '액션 타입 (BALANCE_CHARGE: 충전, BALANCE_MODIFY: 수정)' })
  actionType: string;

  @ApiProperty({ description: '변경 금액 (양수: 증가, 음수: 감소)' })
  amount: number;

  @ApiProperty({ description: '변경 전 잔액' })
  beforeBalance: number;

  @ApiProperty({ description: '변경 후 잔액' })
  afterBalance: number;

  @ApiProperty({ description: '처리자 이메일' })
  operatorEmail: string;

  @ApiProperty({ description: '메모/사유' })
  memo: string | null;
}

export class UserManagementGetBalanceHistoryResDto {
  @ApiProperty({ description: '충전/수정 이력 목록', type: [BalanceHistoryItemDto] })
  list: BalanceHistoryItemDto[];
}

export class WalletHistoryItemDto {
  @ApiProperty({ description: '이력 ID (wallet_transaction.id)' })
  id: string;

  @ApiProperty({ description: '일시 (yyyy-MM-ddTHH:mm:ss)' })
  createdAt: string;

  @ApiProperty({ description: '리소스 타입 (DEPOSIT | CREDIT | CREDIT_EXCESS | POINT)' })
  resourceType: string;

  @ApiProperty({
    description:
      '거래 유형 (CONFIRM | CANCEL | FAIL_REFUND | DISCARD_REFUND | RESEND_DEDUCT | SETTLE_RELEASE | SETTLE_UNDO | GRANT 등)',
  })
  type: string;

  @ApiProperty({ description: '변동액 (차감 음수, 적립/복구 양수)' })
  amount: number;

  @ApiProperty({ description: '변동 후 해당 리소스 잔액', nullable: true })
  balanceAfter: number | null;

  @ApiProperty({ description: '주문 ID', nullable: true })
  orderId: number | null;

  @ApiProperty({ description: '메모/사유', nullable: true })
  memo: string | null;
}

export class UserManagementGetWalletHistoryResDto {
  @ApiProperty({ description: 'wallet_transaction 이력 목록', type: [WalletHistoryItemDto] })
  list: WalletHistoryItemDto[];
}

export class UserCompanyViewDto {
  @ApiProperty({ description: '회사 ID (user_company.id)' })
  id: number;

  @ApiProperty({ description: '사업자명' })
  businessName: string;

  @ApiProperty({ description: '사업자등록번호' })
  businessNumber: string;
}

export class UserManagementGetCompanyListResDto extends GetListResDto {
  @ApiProperty({
    description: '고객사 (회사) list',
    type: [UserCompanyViewDto],
  })
  list: UserCompanyViewDto[];
}

export class MaximumLimitHistoryItemDto {
  @ApiProperty({ description: '이력 ID' })
  id: number;

  @ApiProperty({ description: '일시 (yyyy-MM-ddTHH:mm:ss)' })
  createdAt: string;

  @ApiProperty({ description: '변경 전 금액' })
  beforeMaximumLimit: number;

  @ApiProperty({ description: '변경 후 금액' })
  afterMaximumLimit: number;

  @ApiProperty({ description: '처리자 이메일' })
  operatorEmail: string;

  @ApiProperty({ description: '변경 사유' })
  memo: string | null;
}

export class UserManagementGetMaximumLimitHistoryResDto {
  @ApiProperty({ description: '최대서비스한도 변경 이력 목록', type: [MaximumLimitHistoryItemDto] })
  list: MaximumLimitHistoryItemDto[];
}
