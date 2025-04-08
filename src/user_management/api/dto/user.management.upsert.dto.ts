import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsNotEmpty, IsNumber, IsOptional } from 'class-validator';
import { IUserAuthority } from '../../../user/interface/user.authority';
import { IUserSettleCondition } from '../../../user/interface/user.settle.condition';
import { IUserSettleMethod } from '../../../user/interface/user.settle.method';
import { IUserBusinessType } from '../../../user/interface/user.business.type';

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
  @IsNotEmpty()
  bankName: string;

  @ApiProperty({
    description: '계좌번호',
  })
  // ============================
  @IsNotEmpty()
  bankNumber: string;

  @ApiProperty({
    description: '카드명',
  })
  // ============================
  @IsNotEmpty()
  cardName: string;

  @ApiProperty({
    description: '카드 번호',
  })
  // ============================
  @IsNotEmpty()
  cardNumber: string;

  @ApiProperty({
    description: '발신 번호',
  })
  // ============================
  @IsOptional()
  fromPhoneNumber: string | null;
}
