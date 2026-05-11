import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CancelWebhookViewDto {
  @ApiProperty({ nullable: true, description: '폐기 통보 수신 URL. NULL이면 미설정' })
  url: string | null;

  @ApiProperty({ description: 'webhook 활성화 여부' })
  enabled: boolean;
}

export class UpdateCancelWebhookReqDto {
  @ApiProperty({ description: 'HTTPS URL. 사설망/loopback 차단' })
  @IsString()
  @MaxLength(512)
  url: string;

  @ApiProperty({ description: '활성화 여부. true 시 URL 필수' })
  @IsBoolean()
  enabled: boolean;
}

export class CancelWebhookTestResDto {
  @ApiProperty()
  ok: boolean;

  @ApiProperty({ nullable: true, description: 'HTTP status (네트워크 실패 시 NULL)' })
  httpStatus: number | null;

  @ApiProperty()
  responseTimeMs: number;

  @ApiPropertyOptional({ nullable: true })
  errorMessage?: string | null;
}

export class CancelWebhookLogQueryDto {
  @ApiPropertyOptional({ description: '시작일 (ISO 8601)' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ description: '종료일 (ISO 8601)' })
  @IsOptional()
  @IsString()
  to?: string;

  @ApiPropertyOptional({ enum: ['all', 'success', 'failure'] })
  @IsOptional()
  @IsIn(['all', 'success', 'failure'])
  result?: 'all' | 'success' | 'failure';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  trId?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  size?: number;
}

export class CancelWebhookLogItemDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ nullable: true })
  trId: string | null;

  @ApiProperty()
  eventType: string;

  @ApiProperty()
  eventId: string;

  @ApiProperty()
  isSuccess: boolean;

  @ApiProperty({ nullable: true })
  httpStatus: number | null;

  @ApiProperty({ nullable: true })
  responseTimeMs: number | null;

  @ApiProperty({ nullable: true })
  errorMessage: string | null;

  @ApiProperty()
  requestBodyPreview: string;

  @ApiProperty({ nullable: true })
  responseBodyPreview: string | null;
}

export class CancelWebhookLogListResDto {
  @ApiProperty({ type: [CancelWebhookLogItemDto] })
  items: CancelWebhookLogItemDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  size: number;
}
