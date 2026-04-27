import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IExternalApiSsgRequestStatus } from '../../../external_api/interface/external.api.ssg.request.status';

export class ApiKeyAllowedIpDto {
  @ApiProperty({ description: '단일 IP (IPv4/IPv6). CIDR 미지원' })
  @IsString()
  @Length(1, 45)
  ip: string;

  @ApiPropertyOptional({ description: '용도 설명 (예: 본사 NAT)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  description?: string;
}

export class GenerateApiKeyReqDto {
  @ApiPropertyOptional({ description: '재발급 시 IP 화이트리스트를 초기화할지 여부 (기본 false=유지)' })
  @IsOptional()
  @IsBoolean()
  resetAllowedIps?: boolean;
}

export class GenerateApiKeyByAdminReqDto extends GenerateApiKeyReqDto {
  @ApiPropertyOptional({ description: '재발송 최대 횟수 (NULL=시스템 기본값). 발급 시 초기 설정용' })
  @IsOptional()
  @IsInt()
  @Min(0)
  resendMaxCount?: number | null;
}

export class UpdateAllowedIpsReqDto {
  @ApiProperty({ type: [ApiKeyAllowedIpDto], description: 'IP 목록 통째 교체' })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ApiKeyAllowedIpDto)
  ips: ApiKeyAllowedIpDto[];
}

export class UpdateApiKeySettingsReqDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'SSG 활성화 여부. 비활성화는 직접 가능, 활성화는 요청-승인 워크플로우 권장' })
  @IsOptional()
  @IsBoolean()
  ssgEnabled?: boolean;

  @ApiPropertyOptional({ description: '재발송 최대 횟수 (NULL=시스템 기본값)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  resendMaxCount?: number | null;
}

export class CreateSsgRequestReqDto {
  @ApiProperty({ description: 'SSG 사용 신청 사유' })
  @IsString()
  @Length(1, 500)
  reason: string;
}

export class DecideSsgRequestReqDto {
  @ApiPropertyOptional({ description: '승인/거부 메모' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ApiKeyAllowedIpResDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  ip: string;

  @ApiPropertyOptional()
  description: string | null;
}

export class ApiKeyInfoResDto {
  @ApiProperty({ description: '계정 보유 여부' })
  exists: boolean;

  @ApiPropertyOptional()
  accountId?: string;

  @ApiPropertyOptional()
  isActive?: boolean;

  @ApiPropertyOptional()
  ssgEnabled?: boolean;

  @ApiPropertyOptional({ description: 'NULL=시스템 기본값' })
  resendMaxCount?: number | null;

  @ApiPropertyOptional({ type: [ApiKeyAllowedIpResDto] })
  allowedIps?: ApiKeyAllowedIpResDto[];
}

export class SsgRequestResDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  accountId: string;

  @ApiProperty()
  requestedByUserId: number;

  @ApiPropertyOptional()
  requestedByUserName?: string;

  @ApiProperty()
  reason: string;

  @ApiProperty({ enum: IExternalApiSsgRequestStatus })
  status: IExternalApiSsgRequestStatus;

  @ApiPropertyOptional()
  decidedByUserId?: number | null;

  @ApiPropertyOptional()
  decidedByUserName?: string | null;

  @ApiPropertyOptional()
  decidedAt?: Date | null;

  @ApiPropertyOptional()
  decisionNote?: string | null;

  @ApiProperty()
  createdAt: Date;
}
