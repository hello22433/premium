import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class OrderFromGetPhoneReqQueryDto {
  @ApiProperty({
    description: 'user id',
  })
  // ==============================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  userId?: number;
}

export class OrderFromCreatePhoneReqDto {
  @ApiProperty({
    description: '발신 핸드폰 번호',
  })
  // ==============================
  @IsNotEmpty()
  from: string;

  @ApiProperty({
    description: 'user id',
  })
  // ==============================
  @IsOptional()
  @IsNumber()
  userId?: number;
}

export class OrderFromCreateEmailReqDto {
  @ApiProperty({
    description: '발신 이메일',
  })
  // ==============================
  @IsNotEmpty()
  from: string;

  @ApiProperty({
    description: 'user id',
  })
  // ==============================
  @IsOptional()
  @IsNumber()
  userId?: number;
}

export class OrderFromDeleteEmailReqDto {
  @ApiProperty({
    description: '발신 이메일 ID',
  })
  // ==============================
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
  // ==============================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;
}

export class OrderFromAdminApproveReqDto {
  @ApiProperty({
    description: '발신번호/이메일 ID',
  })
  // ==============================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;
}

export class OrderFromAdminRejectReqDto {
  @ApiProperty({
    description: '발신번호/이메일 ID',
  })
  // ==============================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;
}

export class OrderFromAdminGetListReqDto {
  @ApiProperty({
    description: '페이지 번호',
    default: 1,
  })
  // ==============================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  page?: number = 1;

  @ApiProperty({
    description: '페이지당 항목 수',
    default: 10,
  })
  // ==============================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  take?: number = 10;
}

export class OrderFromSetDefaultReqDto {
  @ApiProperty({
    description: '발신번호 ID',
  })
  // ==============================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;

  @ApiProperty({
    description: 'user id (관리자가 다른 사용자의 기본 발신번호를 설정할 때 사용)',
  })
  // ==============================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  userId?: number;
}
