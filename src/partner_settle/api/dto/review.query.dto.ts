import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ReviewSource } from '../../application/partner.settle.review.query.service';

const REVIEW_SOURCES: ReviewSource[] = ['LEDGER', 'TRANSITION_OBSERVATION', 'ORPHAN_EVENT'];
const PROPOSAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

class CursorPageQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: '현재 필터에 결박된 cursor' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  cursor?: string;
}

export class NeedsReviewQueryDto extends CursorPageQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  partnerCompanyId?: number;

  @ApiPropertyOptional({ enum: REVIEW_SOURCES })
  @IsOptional()
  @IsIn(REVIEW_SOURCES)
  source?: ReviewSource;

  @ApiPropertyOptional({ description: 'lane 상태 (NEEDS_REVIEW, UNRESOLVED, ORPHAN_PENDING)' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  reviewCode?: string;
}

export class ManualLedgerProposalQueryDto extends CursorPageQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  partnerCompanyId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  orderDeliveryId?: number;

  @ApiPropertyOptional({ enum: PROPOSAL_STATUSES })
  @IsOptional()
  @IsIn(PROPOSAL_STATUSES)
  status?: 'PENDING' | 'APPROVED' | 'REJECTED';
}

export class OrphanInboxQueryDto extends CursorPageQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  partnerCompanyId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  orderDeliveryId?: number;
}
