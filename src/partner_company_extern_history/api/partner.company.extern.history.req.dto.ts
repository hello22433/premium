import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsInt, Min, IsEnum, IsBoolean, IsIn } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';

export class GetPartnerCompanyExternHistoryListReqDto {
  @ApiPropertyOptional({
    description: '시작 날짜 (YYYY-MM-DD)',
    example: '2025-01-01',
  })
  @IsOptional()
  @IsString()
  startAt?: string;

  @ApiPropertyOptional({
    description: '종료 날짜 (YYYY-MM-DD)',
    example: '2025-01-31',
  })
  @IsOptional()
  @IsString()
  endAt?: string;

  @ApiPropertyOptional({
    description: '협력사 타입',
    enum: IPartnerCompanyType,
    example: 'GALAXIA',
  })
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsEnum(IPartnerCompanyType)
  type?: IPartnerCompanyType;

  @ApiPropertyOptional({
    description: '성공/실패 여부',
    example: false,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === '' || value === undefined || value === null) return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  isSuccess?: boolean;

  @ApiPropertyOptional({ description: '발송상태 필터 (FAIL: 실패, RESEND: 재발송)', enum: ['FAIL', 'RESEND'] })
  @IsOptional()
  @IsIn(['FAIL', 'RESEND'])
  sendStatus?: 'FAIL' | 'RESEND';

  @ApiPropertyOptional({
    description: '검색어 (context 내 키워드, transactionId, 에러코드 등)',
    example: 'E001',
  })
  @IsOptional()
  @IsString()
  searchKeyword?: string;

  @ApiPropertyOptional({
    description: '페이지 번호',
    example: 1,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    description: '페이지당 항목 수',
    example: 20,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  take: number = 20;
}