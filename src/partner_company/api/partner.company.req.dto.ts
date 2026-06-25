import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsNotEmpty, IsNumber, IsOptional, Matches, Min } from 'class-validator';
import { IPartnerCompanySettleCondition } from '../interface/partner.company.settle.condition';
import { dateAtRegexp } from '../../common/domain/date.regexp';
import { IPartnerCompanySettleMethod } from '../interface/partner.company.settle.method';
import { Type } from 'class-transformer';
import { IPartnerCompanyType } from '../interface/partner.company.type';

export class PartnerCompanyGetSearchListReqQueryDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '협력사 명',
  })
  @IsOptional()
  businessName?: string;
}

export class PartnerCompanyGetListReqQueryDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '등록 시작 일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  @IsOptional()
  @Matches(dateAtRegexp)
  startCreatedAt?: string;

  @ApiPropertyOptional({
    description: '등록 종료 일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  @IsOptional()
  @Matches(dateAtRegexp)
  endCreatedAt?: string;

  @ApiPropertyOptional({
    description: '정산 조건 ex) 선정산 : PRE_PAYMENT, 후정산: POST_PAYMENT',
  })
  @IsOptional()
  @IsIn(['PRE_PAYMENT', 'POST_PAYMENT'])
  settleCondition?: IPartnerCompanySettleCondition;

  @ApiPropertyOptional({
    description:
      '검색 타입 ex) 전체: ALL, 이메일: email, 협력사명: businessName, 담당자명: personName, 담당자연락처: personPhoneNumber',
    enum: ['ALL', 'email', 'businessName', 'personName', 'personPhoneNumber'],
  })
  @IsOptional()
  @IsIn(['ALL', 'email', 'businessName', 'personName', 'personPhoneNumber'])
  searchType?: 'ALL' | 'email' | 'businessName' | 'personName' | 'personPhoneNumber';

  @ApiPropertyOptional({
    description: '검색어 키워드',
  })
  @IsOptional()
  searchKeyword?: string;

  @ApiPropertyOptional({
    description: '당사자 이메일',
  })
  @IsOptional()
  email?: string;

  @ApiPropertyOptional({
    description: '협력사명',
  })
  @IsOptional()
  businessName?: string;

  @ApiPropertyOptional({
    description: '담당자명',
  })
  @IsOptional()
  personName?: string;

  @ApiPropertyOptional({
    description: '담당자 연락처',
  })
  @IsOptional()
  personPhoneNumber?: string;
}

export class PartnerCompanyGetDetailReqParamDto {
  @ApiProperty({
    description: '협력사 id',
  })
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;
}

export class PartnerCompanyCreateReqDto {
  @ApiPropertyOptional({
    description: '법인 등록 번호',
  })
  @IsOptional()
  corporateNumber: string | null = null;

  @ApiProperty({
    description: '사업자 등록 번호',
  })
  @IsNotEmpty()
  businessNumber: string;

  @ApiProperty({
    description: '사업자 명',
  })
  @IsNotEmpty()
  businessName: string;

  @ApiProperty({
    description: '사업자 주소',
  })
  @IsNotEmpty()
  businessAddress: string;

  @ApiProperty({
    description: '사업자 연락처',
  })
  @IsNotEmpty()
  businessPhoneNumber: string;

  @ApiProperty({
    description: '담당자 이름',
  })
  @IsNotEmpty()
  personName: string;

  @ApiProperty({
    description: '담당자 연락처',
  })
  @IsNotEmpty()
  personPhoneNumber: string;

  @ApiProperty({
    description: '담당자 이메일',
  })
  @IsNotEmpty()
  personEmail: string;

  @ApiProperty({
    description: '정산 조건 ex) 선정산 : PRE_PAYMENT, 후정산 : POST_PAYMENT',
  })
  @IsNotEmpty()
  @IsIn(['PRE_PAYMENT', 'POST_PAYMENT'])
  settleCondition: IPartnerCompanySettleCondition;

  @ApiProperty({
    description: '정산 방법, ex) 카드: CARD, 현금: CASH',
  })
  @IsNotEmpty()
  @IsIn(['CARD', 'CASH'])
  settleMethod: IPartnerCompanySettleMethod;

  @ApiProperty({
    description: '여신한도',
  })
  @IsNotEmpty()
  @IsNumber()
  maximumLimit: number;

  @ApiProperty({
    description: '은행 이름',
  })
  @IsNotEmpty()
  bankName: string;

  @ApiProperty({
    description: '은행 계좌 번호',
  })
  @IsNotEmpty()
  bankNumber: string;

  @ApiProperty({
    description: '정산 일',
  })
  @IsNotEmpty()
  @IsNumber()
  @Min(1)
  settleDay: number;

  @ApiPropertyOptional({
    enum: IPartnerCompanyType,
    description: '협력사 타입',
  })
  @IsOptional()
  @IsEnum(IPartnerCompanyType)
  type?: IPartnerCompanyType;

  @ApiPropertyOptional({
    description: '유효기간 시작일 설정 (true: 다음날부터, false: 당일 포함)',
    default: true,
  })
  @IsOptional()
  validityStartsNextDay?: boolean;
}

export class PartnerCompanyUpdateReqDto extends PartnerCompanyCreateReqDto {
  @ApiProperty({
    description: 'partner company id',
  })
  @IsNumber()
  @IsNotEmpty()
  id: number;
}
