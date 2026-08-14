import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsInt, IsString, Matches, MaxLength, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class AdjustmentProposalQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  partnerCompanyId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: 'PENDING' | 'APPROVED' | 'REJECTED';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  resolutionGroupKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  sourceLedgerId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  afterCreatedAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  afterId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  @Type(() => Number)
  limit?: number;
}

export class AdjustmentProposalCreateDto {
  @ApiProperty()
  @IsInt()
  partnerCompanyId: number;

  @ApiProperty()
  @IsString()
  @MaxLength(32)
  subItemKey: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sourceLedgerId?: number;

  @ApiProperty({ description: 'canonical 정수 문자열' })
  @IsString()
  @Matches(/^(0|-?[1-9]\d*)$/, { message: 'amount 는 canonical 정수 문자열이어야 합니다 (예: "0", "-100", "9500")' })
  amount: string;

  @ApiProperty()
  @IsString()
  @MaxLength(1000)
  reason: string;

  @ApiProperty()
  @IsString()
  @MaxLength(128)
  requestKey: string;
}

export class AdjustmentProposalApproveDto {
  @ApiPropertyOptional({ description: 'override 금액 (canonical 정수 문자열)' })
  @IsOptional()
  @IsString()
  @Matches(/^(0|-?[1-9]\d*)$/, { message: 'amount 는 canonical 정수 문자열이어야 합니다' })
  amount?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  amountOverrideReason?: string;
}

export class AdjustmentProposalRejectDto {
  @ApiProperty()
  @IsString()
  @MaxLength(1000)
  reason: string;
}
