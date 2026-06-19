import { Transform, Type } from 'class-transformer';
import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class ForbiddenWordGetListReqQueryDto extends PagingReqDto {
  @ApiPropertyOptional({ description: '검색어 (단어 부분일치)' })
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional({ description: '카테고리 필터' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ description: '활성 여부 필터 (true: 활성만, false: 비활성만, 미지정: 전체)' })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined; // 미지정 → 전체
  })
  @IsBoolean()
  isActive?: boolean;
}

export class ForbiddenWordIdParamDto {
  @ApiProperty({ description: 'forbidden_word id' })
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;
}

export class ForbiddenWordCreateReqDto {
  @ApiProperty({ description: '금칙어' })
  @IsNotEmpty()
  @IsString()
  word: string;

  @ApiPropertyOptional({ description: '분류 (욕설/성적/대출/도박/유흥 등)' })
  @IsOptional()
  @IsString()
  category?: string | null;

  @ApiProperty({ description: '변경 사유 (필수)' })
  @IsNotEmpty()
  @IsString()
  reason: string;
}

export class ForbiddenWordUpdateReqDto {
  @ApiPropertyOptional({ description: '금칙어' })
  @IsOptional()
  @IsString()
  word?: string;

  @ApiPropertyOptional({ description: '분류' })
  @IsOptional()
  @IsString()
  category?: string | null;

  @ApiPropertyOptional({ description: '활성 여부 (true: 활성, false: 비활성)' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({ description: '변경 사유 (필수)' })
  @IsNotEmpty()
  @IsString()
  reason: string;
}

export class ForbiddenWordDeleteReqDto {
  @ApiProperty({ description: '변경 사유 (필수)' })
  @IsNotEmpty()
  @IsString()
  reason: string;
}

export class ForbiddenWordGetHistoryReqQueryDto extends PagingReqDto {
  @ApiPropertyOptional({ description: '단어 (부분일치)' })
  @IsOptional()
  @IsString()
  word?: string;

  @ApiPropertyOptional({ description: '변경자 이메일 (부분일치)' })
  @IsOptional()
  @IsString()
  changedByEmail?: string;

  @ApiPropertyOptional({ description: '시작일 (yyyy-MM-dd)' })
  @IsOptional()
  @IsString()
  startDate?: string;

  @ApiPropertyOptional({ description: '종료일 (yyyy-MM-dd)' })
  @IsOptional()
  @IsString()
  endDate?: string;
}

export class ForbiddenWordGetBlockLogReqQueryDto extends PagingReqDto {
  @ApiPropertyOptional({ description: '작성자 이메일 (부분일치)' })
  @IsOptional()
  @IsString()
  userEmail?: string;

  @ApiPropertyOptional({ description: '시작일 (yyyy-MM-dd)' })
  @IsOptional()
  @IsString()
  startDate?: string;

  @ApiPropertyOptional({ description: '종료일 (yyyy-MM-dd)' })
  @IsOptional()
  @IsString()
  endDate?: string;
}
