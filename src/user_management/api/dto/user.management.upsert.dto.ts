import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsArray, ArrayNotEmpty } from 'class-validator';
import { IUserAuthority } from '../../../user/interface/user.authority';
import { IUserSettleCondition } from '../../../user/interface/user.settle.condition';
import { IUserSettleMethod } from '../../../user/interface/user.settle.method';
import { IUserBusinessType } from '../../../user/interface/user.business.type';
import { UserSettlePeriodConditionEnum } from '../../../user/interface/user.settle.period.condition.enum';
import { IOrderSendMethod } from '../../../order/interface/order.send.method';
import { CompanyType } from '../../../common/domain/company.type';
import { LoginVerifyMethod } from '../../../user/interface/login.verify.method';

export class UserManagementUpsertDto {
  @ApiProperty({
    description: '권한',
  })
  // ===============================
  @IsNotEmpty()
  @IsEnum(IUserAuthority)
  authority: IUserAuthority;

  @ApiProperty({
    description: '담당자 명',
  })
  // ===============================
  @IsNotEmpty()
  personName: string;

  @ApiProperty({
    description: '담당자 연락처',
  })
  // ===============================
  @IsNotEmpty()
  personPhoneNumber: string;

  @ApiProperty({
    description: '담당자 이메일',
  })
  // ===============================
  @IsNotEmpty()
  personEmail: string;

  @ApiPropertyOptional({
    description: '법인 유무 ex) 개인 : INDIVIDUAL, 법인 : CORPORATE',
  })
  // ===============================
  @IsOptional()
  @IsEnum(IUserBusinessType)
  businessType: IUserBusinessType | null = null;

  @ApiPropertyOptional({
    description: '법인 등록 번호',
  })
  // ===============================
  @IsOptional()
  corporateNumber: string | null = null;

  @ApiProperty({
    description: '사업자 등록번호',
  })
  // ===============================
  @IsNotEmpty()
  businessNumber: string;

  @ApiProperty({
    description: '사업자명',
  })
  // ===============================
  @IsNotEmpty()
  businessName: string;

  @ApiProperty({
    description: '사업자 주소',
  })
  // ===============================
  @IsNotEmpty()
  businessAddress: string;

  @ApiProperty({
    description: '사업자 연락처',
  })
  // ===============================
  @IsNotEmpty()
  businessPhoneNumber: string;

  @ApiPropertyOptional({
    description: '허용 IP',
  })
  // ===============================
  @IsOptional()
  ip: string | null = null;

  @ApiProperty({
    description: '정산 조건',
  })
  // ============================
  @IsNotEmpty()
  @IsEnum(IUserSettleCondition)
  settleCondition: IUserSettleCondition;

  @ApiProperty({
    description: '정산 방법',
  })
  // ============================
  @IsNotEmpty()
  @IsEnum(IUserSettleMethod)
  settleMethod: IUserSettleMethod;

  @ApiProperty({
    description: '최대 서비스 한도',
  })
  // ============================
  @IsNotEmpty()
  @IsNumber()
  maximumLimit: number;

  @ApiPropertyOptional({
    description: '최대 서비스 한도 변경 사유',
  })
  // ============================
  @IsOptional()
  maximumLimitMemo?: string;

  @ApiProperty({
    description: '은행 이름',
  })
  // ============================
  @IsOptional()
  bankName: string = '';

  @ApiProperty({
    description: '계좌번호',
  })
  // ============================
  @IsOptional()
  bankNumber: string = '';

  @ApiProperty({
    description: '카드명',
  })
  // ============================
  @IsOptional()
  cardName: string = '';

  @ApiProperty({
    description: '카드 번호',
  })
  // ============================
  @IsOptional()
  cardNumber: string = '';

  @ApiProperty({
    description: '발신 번호',
  })
  // ============================
  @IsOptional()
  fromPhoneNumber: string | null;

  @ApiProperty({
    description:
      '정산 조건 월 타입 ex) CURRENT_MONTH: 당월, NEXT_MONTH: 익월, NEXT_MONTH_AFTER: 익익월, DELIVERY_DATE: 발송일',
  })
  // ============================
  @IsOptional()
  @IsEnum(UserSettlePeriodConditionEnum)
  settlePeriodCondition: UserSettlePeriodConditionEnum | null;

  @ApiProperty({
    description: '발송 조건 일',
  })
  // ============================
  @IsOptional()
  @IsNumber()
  settlePeriodCount: number | null;

  @ApiPropertyOptional({
    description: '중복번호제어 (0: 중복허용, 1~10: 해당 개수만큼 중복 허용)',
    default: 0,
  })
  // ============================
  @IsOptional()
  @IsNumber()
  duplicatePhoneLimit: number = 0;

  @ApiPropertyOptional({
    description: '권한 허용 list',
  })
  // ============================
  @IsOptional()
  @IsArray()
  authorityList: string[] = [];

  @ApiPropertyOptional({
    description: '업태',
  })
  // ============================
  @IsOptional()
  industryType: string | null = null;

  @ApiPropertyOptional({
    description: '종목',
  })
  // ============================
  @IsOptional()
  industryItem: string | null = null;

  @ApiPropertyOptional({
    description: '기본 문서 양식',
    enum: CompanyType,
    default: CompanyType.ENMAD,
  })
  // ============================
  @IsOptional()
  @IsEnum(CompanyType)
  documentCompanyType?: CompanyType;

  @ApiProperty({
    description: '허용 발신수단 목록 (ALIM_TALK, MMS, EMAIL)',
    example: ['ALIM_TALK', 'MMS', 'EMAIL'],
  })
  // ============================
  @IsArray()
  @ArrayNotEmpty({ message: '발신수단은 최소 1개 이상 선택해야 합니다.' })
  @IsEnum(IOrderSendMethod, { each: true, message: '유효하지 않은 발신수단입니다.' })
  allowedSendMethods: IOrderSendMethod[] = [IOrderSendMethod.ALIM_TALK, IOrderSendMethod.MMS, IOrderSendMethod.EMAIL];

  @ApiPropertyOptional({
    description: '로그인 인증 방식 (EMAIL: 이메일 인증, PHONE: 휴대번호 인증)',
    enum: LoginVerifyMethod,
    default: LoginVerifyMethod.EMAIL,
  })
  // ============================
  @IsOptional()
  @IsEnum(LoginVerifyMethod)
  loginVerifyMethod: LoginVerifyMethod = LoginVerifyMethod.EMAIL;
}
