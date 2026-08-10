import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { IReviewResolutionMode } from '../../../entity/partner.settle.review.resolution.entity';
import { IPartnerSettleReviewCode } from '../../interface/partner.settle.source.type';

const normalizeText = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.normalize('NFC').trim() : value;
const REVIEW_CODES: IPartnerSettleReviewCode[] = [
  'COVERAGE_GAP',
  'TIME_UNRECOVERABLE',
  'PRICE_UNRECOVERABLE',
  'POLICY_CONFLICT',
  'UNKNOWN_PROVIDER_EVENT',
];

const RESOLUTION_MODES: IReviewResolutionMode[] = ['SET_TIME', 'SET_PRICE', 'SET_UNKNOWN', 'RECLASSIFY', 'DISCARD'];

export class ReviewResolutionProposeReqDto {
  @ApiProperty({ description: 'NEEDS_REVIEW 원장 ID' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  ledgerId: number;

  @ApiProperty({ enum: REVIEW_CODES, description: '검토 원인 코드' })
  @IsIn(REVIEW_CODES)
  reviewCode: IPartnerSettleReviewCode;

  @ApiProperty({ enum: RESOLUTION_MODES, description: '해소 방식' })
  @IsIn(RESOLUTION_MODES)
  resolutionMode: IReviewResolutionMode;

  @ApiPropertyOptional({ description: '해소 방식별 확정값', type: Object, nullable: true })
  @IsOptional()
  @IsObject()
  proposedValues?: Record<string, unknown> | null;

  @ApiProperty({ description: '증적 참조' })
  @Transform(normalizeText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  @Matches(/^[^\u0000-\u001F\u007F-\u009F]*$/u, { message: 'evidenceRef에 제어문자를 포함할 수 없습니다.' })
  evidenceRef: string;

  @ApiPropertyOptional({ description: '제안 사유', nullable: true })
  @Transform(normalizeText)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string | null;

  @ApiProperty({ description: '멱등 요청 키' })
  @Transform(normalizeText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'requestKey는 영문, 숫자, 밑줄, 하이픈만 사용할 수 있습니다.' })
  requestKey: string;
}

export class ReviewResolutionApproveReqDto {
  @ApiPropertyOptional({ description: '승인 사유', nullable: true })
  @Transform(normalizeText)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  decisionReason?: string | null;
}

export class ReviewResolutionRejectReqDto {
  @ApiProperty({ description: '반려 사유' })
  @Transform(normalizeText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason: string;
}
