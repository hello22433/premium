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
