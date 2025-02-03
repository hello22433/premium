import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsNumber, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class BrandGetSearchListReqDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '검색하고자 하는 브랜드 명',
  })
  // ========================================
  @IsOptional()
  searchText?: string;
}

export class BrandGetDetailReqParamDto {
  @ApiProperty({
    description: 'brand id',
  })
  // ========================================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;
}

export class BrandCreateReqDto {
  @ApiProperty({
    description: '브랜드 이름 (한글)',
  })
  // ========================================
  @IsNotEmpty()
  nameKorean: string;

  @ApiProperty({
    description: '브랜드 이름 (영문)',
  })
  // ========================================
  @IsNotEmpty()
  nameEnglish: string;

  // ========================================
  @IsNotEmpty()
  @IsBoolean()
  isUsed: boolean;
}

export class BrandUpdateReqDto extends BrandCreateReqDto {
  @ApiProperty({
    description: 'brand id',
  })
  // ========================================
  @IsNotEmpty()
  @IsNumber()
  id: number;
}
