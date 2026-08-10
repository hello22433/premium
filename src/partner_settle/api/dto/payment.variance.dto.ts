import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { IPartnerSettlePaymentVarianceProposalStatus } from '../../interface/partner.settle.batch.type';

export class VarianceQueryDto {
  @ApiPropertyOptional({ description: '상태 필터', enum: ['PENDING', 'APPROVED', 'REJECTED'] })
  @IsOptional()
  @IsIn(['PENDING', 'APPROVED', 'REJECTED'])
  status?: IPartnerSettlePaymentVarianceProposalStatus;

  @ApiPropertyOptional({ description: '협력사 id' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  partnerCompanyId?: number;

  @ApiPropertyOptional({ description: 'batch id' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  batchId?: number;

  @ApiPropertyOptional({ description: '페이지 크기 (기본 50, 최대 200)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: '건너뛸 건수' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class VarianceDecisionReqDto {
  @ApiProperty({ description: '승인·반려 사유 (필수)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  decisionReason: string;
}
