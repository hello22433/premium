import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class DownloadWithPasswordReqDto {
  @ApiProperty({
    description: '비밀번호',
    example: 'mypassword123',
  })
  @IsNotEmpty()
  @IsString()
  password: string;

  @ApiProperty({
    description: '다운로드 사유',
    example: '월간 보고서 작성을 위한 데이터 다운로드',
  })
  @IsNotEmpty()
  @IsString()
  downloadReason: string;
}

export class GetActivityLogListReqDto {
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
    description: '액션 타입 (EXCEL_DOWNLOAD, LOGIN 등)',
    example: 'EXCEL_DOWNLOAD',
  })
  @IsOptional()
  @IsString()
  actionType?: string;

  @ApiPropertyOptional({
    description: '검색어 (IP 주소 또는 이메일)',
    example: '192.168.1.1',
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

export class DownloadActivityLogExcelReqDto {
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
    description: '액션 타입 (EXCEL_DOWNLOAD, LOGIN 등)',
    example: 'EXCEL_DOWNLOAD',
  })
  @IsOptional()
  @IsString()
  actionType?: string;

  @ApiPropertyOptional({
    description: '검색어 (IP 주소 또는 이메일)',
    example: '192.168.1.1',
  })
  @IsOptional()
  @IsString()
  searchKeyword?: string;

  @ApiProperty({
    description: '다운로드 사유',
    example: '월간 보고서 작성을 위한 활동 로그 분석',
  })
  @IsNotEmpty()
  @IsString()
  downloadReason: string;
}
