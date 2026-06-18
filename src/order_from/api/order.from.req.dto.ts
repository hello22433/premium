import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { TelecomCertType } from '../interface/order.from.definition.type';

export class OrderFromGetPhoneReqQueryDto {
  @ApiProperty({
    description: 'user id',
    required: false,
  })
  // 빈 쿼리(`?userId=`)·공백은 undefined 로 떨어뜨린다. Number('') === 0 footgun 방지.
  // 0 이 흘러가면 서비스의 `getQuery.userId > 0` 가 본인 조회로 폴백하지 못한다.
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'string' && value.trim() === '') return undefined;
    return Number(value);
  })
  userId?: number;
}

export class OrderFromCreatePhoneReqDto {
  @ApiProperty({ description: '발신 핸드폰 번호' })
  @IsString()
  @IsNotEmpty()
  from: string;

  @ApiProperty({ description: 'user id' })
  @IsOptional()
  @IsNumber()
  userId?: number;

  @ApiProperty({
    description: '통신이용증명 유형 (FILE_ATTACHED: 파일첨부, PRE_DELIVERED: 기전달)',
    enum: TelecomCertType,
    required: false,
  })
  @IsOptional()
  @IsEnum(TelecomCertType)
  telecomCertType?: TelecomCertType;

  @ApiProperty({ description: '통신이용증명 파일 URL (telecomCertType이 FILE_ATTACHED일 때)', required: false })
  @IsOptional()
  @IsString()
  telecomCertFile?: string;
}

export class OrderFromCreateEmailReqDto {
  @ApiProperty({
    description: '발신 이메일',
  })
  @IsNotEmpty()
  from: string;

  @ApiProperty({
    description: 'user id',
  })
  @IsOptional()
  @IsNumber()
  userId?: number;
}

export class OrderFromDeleteEmailReqDto {
  @ApiProperty({
    description: '발신 이메일 ID',
  })
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;
}

// ==================== 관리자용 DTO ====================

export class OrderFromAdminDeleteReqDto {
  @ApiProperty({
    description: '발신번호/이메일 ID',
  })
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;
}

export class OrderFromAdminApproveReqDto {
  @ApiProperty({
    description: '발신번호/이메일 ID',
  })
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;
}

export class OrderFromAdminRejectReqDto {
  @ApiProperty({ description: '발신번호/이메일 ID' })
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;

  @ApiProperty({ description: '거절 사유', required: false })
  @IsOptional()
  @IsString()
  rejectReason?: string;
}

export class OrderFromAdminUpdateCertReqDto {
  @ApiProperty({ description: '발신번호 ID' })
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;

  @ApiProperty({
    description: '통신이용증명 유형 (FILE_ATTACHED: 파일첨부, PRE_DELIVERED: 기전달)',
    enum: TelecomCertType,
    required: false,
  })
  @IsOptional()
  @IsEnum(TelecomCertType)
  telecomCertType?: TelecomCertType;

  @ApiProperty({ description: '통신이용증명 파일 URL', required: false })
  @IsOptional()
  @IsString()
  telecomCertFile?: string;
}

export class OrderFromAdminGetListReqDto {
  @ApiProperty({
    description: '페이지 번호',
    default: 1,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  page?: number = 1;

  @ApiProperty({
    description: '페이지당 항목 수',
    default: 10,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  take?: number = 10;

  @ApiProperty({
    description: '사용자 ID (필터링)',
    required: false,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  userId?: number;

  @ApiProperty({
    description: '발신번호 검색 (부분 일치)',
    required: false,
  })
  @IsOptional()
  @IsString()
  search?: string;
}

export class OrderFromSetDefaultReqDto {
  @ApiProperty({
    description: '발신번호 ID',
  })
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;

  @ApiProperty({
    description: 'user id (관리자가 다른 사용자의 기본 발신번호를 설정할 때 사용)',
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  userId?: number;
}

export class OrderFromSetHideSystemReqDto {
  @ApiProperty({
    description: 'MMS 발신번호 선택목록에서 시스템 기본번호(1644-3614) 숨김 여부',
  })
  @IsNotEmpty()
  @IsBoolean()
  hide: boolean;

  @ApiProperty({
    description: 'user id (관리자가 다른 사용자의 설정을 변경할 때 사용)',
    required: false,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  userId?: number;
}
