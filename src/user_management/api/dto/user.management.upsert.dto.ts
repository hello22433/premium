import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsArray } from 'class-validator';
import { IUserAuthority } from '../../../user/interface/user.authority';
import { IUserSettleCondition } from '../../../user/interface/user.settle.condition';
import { IUserSettleMethod } from '../../../user/interface/user.settle.method';
import { IUserBusinessType } from '../../../user/interface/user.business.type';
import { UserSettlePeriodConditionEnum } from '../../../user/interface/user.settle.period.condition.enum';

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
  @IsEmail()
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
}
