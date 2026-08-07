import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';

// ──── confirm ────

export class ExcludeItemDto {
  @ApiProperty({ description: '제외 대상 원장 id' })
  @IsInt()
  ledgerId: number;

  @ApiProperty({ description: '제외 사유 (필수)' })
  @IsString()
  @IsNotEmpty()
  reason: string;

  @ApiProperty({ description: 'SKIP_ONCE | HOLD', enum: ['SKIP_ONCE', 'HOLD'] })
  @IsIn(['SKIP_ONCE', 'HOLD'])
  mode: 'SKIP_ONCE' | 'HOLD';
}

export class ConfirmReqDto {
  @ApiProperty({ description: '협력사 id' })
  @IsInt()
  partnerCompanyId: number;

  @ApiProperty({ description: 'exclusive 종료 경계 (YYYY-MM-DD, KST)' })
  @IsDateString()
  periodEnd: string;

  @ApiProperty({ description: 'confirm 멱등 키 (필수)' })
  @IsString()
  @IsNotEmpty()
  requestKey: string;

  @ApiPropertyOptional({ description: '건별 제외 목록', type: [ExcludeItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExcludeItemDto)
  excludeItems?: ExcludeItemDto[];
}

// ──── unconfirm (release) ────

export class UnconfirmReqDto {
  @ApiProperty({ description: '해제 멱등 키 (필수)' })
  @IsString()
  @IsNotEmpty()
  requestKey: string;

  @ApiProperty({ description: '해제 사유 (필수)' })
  @IsString()
  @IsNotEmpty()
  reason: string;

  @ApiPropertyOptional({ description: 'batchId 모드: 전건 해제', type: Number })
  @IsOptional()
  @IsInt()
  batchId?: number;

  @ApiPropertyOptional({ description: 'ledgerIds 모드: 건별 해제', type: [Number] })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @ArrayMinSize(1)
  ledgerIds?: number[];
}

// ──── hold release ────

export class HoldReleaseReqDto {
  @ApiProperty({ description: '해제 사유 (필수)' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}

// ──── paid ────

export class PaidReqDto {
  @ApiProperty({ description: '지급 멱등 키 (필수)' })
  @IsString()
  @IsNotEmpty()
  paidRequestKey: string;

  @ApiProperty({ description: '실제 송금액 (canonical 정수 문자열, 음수 불허)' })
  @Matches(/^(0|[1-9]\d*)$/, { message: '음수 불허 canonical 정수 문자열이어야 합니다' })
  actualPaidAmount: string;

  @ApiProperty({ description: '지급 근거 (이체 참조번호 등)' })
  @IsString()
  @IsNotEmpty()
  paymentEvidenceRef: string;

  @ApiPropertyOptional({ description: '메모' })
  @IsOptional()
  @IsString()
  memo?: string;
}

// ──── query ────

export class BatchQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  partnerCompanyId?: number;

  @ApiPropertyOptional({ enum: ['CONFIRMED_UNPAID', 'PAID', 'CANCELED'] })
  @IsOptional()
  @IsIn(['CONFIRMED_UNPAID', 'PAID', 'CANCELED'])
  status?: string;
}

// ──── response ────

export class ConfirmResDto {
  @ApiProperty()
  batchId: number;
  @ApiProperty()
  confirmedTotalAmount: string;
  @ApiProperty()
  confirmedCount: number;
  @ApiPropertyOptional()
  estimatedPayableAmount?: string;
  @ApiPropertyOptional()
  isEstimateProvisional?: boolean;
}

export class BatchSummaryResDto {
  @ApiProperty()
  id: number;
  @ApiProperty()
  partnerCompanyId: number;
  @ApiProperty()
  periodEnd: string;
  @ApiProperty()
  status: string;
  @ApiProperty()
  batchType: string;
  @ApiProperty()
  confirmedTotalAmount: string;
  @ApiProperty()
  confirmedCount: number;
  @ApiPropertyOptional()
  finalizedTotalAmount?: string | null;
  @ApiPropertyOptional()
  paidAmount?: string | null;
}

export class UnconfirmResDto {
  @ApiProperty()
  releasedCount: number;
  @ApiProperty()
  requestId: number;
}
