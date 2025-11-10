import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, Matches, Min } from 'class-validator';
import { dateAtRegexp } from '../../common/domain/date.regexp';

export class SsgEventGetListReqDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '생성 시작일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateAtRegexp)
  createdStartAt?: string;

  @ApiPropertyOptional({
    description: '생성 끝 일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateAtRegexp)
  createdEndAt?: string;

  @ApiPropertyOptional({
    description: '행사명',
  })
  // =============================================================
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({
    description: '행사코드',
  })
  // =============================================================
  @IsOptional()
  code?: string;
}

export class SsgEventExcelDownloadReqDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '생성 시작일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateAtRegexp)
  createdStartAt?: string;

  @ApiPropertyOptional({
    description: '생성 끝 일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateAtRegexp)
  createdEndAt?: string;

  @ApiPropertyOptional({
    description: '행사명',
  })
  // =============================================================
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({
    description: '행사코드',
  })
  // =============================================================
  @IsOptional()
  code?: string;

  @ApiProperty({
    description: '비밀번호 (다운로드 확인용)',
  })
  // =============================================================
  @IsNotEmpty()
  password: string;

  @ApiProperty({
    description: '다운로드 사유',
  })
  // =============================================================
  @IsNotEmpty()
  downloadReason: string;
}

export class SsgEventCreateReqDto {
  @ApiProperty({
    description: '행사 코드',
  })
  // =============================================================
  @IsNotEmpty()
  code: string;

  @ApiProperty({
    description: '행사 순번',
  })
  // =============================================================
  @IsOptional()
  @IsNumber()
  @Min(1)
  order: number | undefined;

  @ApiProperty({
    description: '행사 번호',
  })
  // =============================================================
  @IsNotEmpty()
  no: string;

  @ApiProperty({
    description: '행사 명',
  })
  // =============================================================
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    description: '행사 시작 기간 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @IsNotEmpty()
  @Matches(dateAtRegexp)
  startAt: Date;

  @ApiProperty({
    description: '행사 마감 기간 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @IsNotEmpty()
  @Matches(dateAtRegexp)
  endAt: Date;

  @ApiProperty({
    description: '쿠폰 유효기간(일)',
  })
  // =============================================================
  @IsNotEmpty()
  @IsNumber()
  couponExpiration: number;

  @ApiProperty({
    description: '행사 금액',
  })
  // =============================================================
  @IsNotEmpty()
  @IsNumber()
  eventPrice: number;
}

export class SsgEventUpdateAmountReqDto {
  @ApiProperty({
    description: 'event id',
  })
  @IsNotEmpty()
  @IsNumber()
  // =============================================================
  id: number;

  @ApiProperty({
    description: '충전할 금액',
  })
  @IsNotEmpty()
  @IsNumber()
  // =============================================================
  amount: number;
}

export class SsgEventGetValidListReqDto {
  @ApiPropertyOptional({
    description: '요청한 쿠폰 유효기간(일)으로 필터링',
  })
  // =============================================================
  @IsOptional()
  @IsNumber()
  couponExpiration?: number;
}
