import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsEnum, IsNotEmpty, IsNumber, IsOptional, Matches } from 'class-validator';
import { IProductUseStatus } from '../../product/interface/product.status';
import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { Type } from 'class-transformer';
import { dateAtRegexp } from '../../common/domain/date.regexp';

export class ProductChoiceGetListReqQueryDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '생성 시작일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @Matches(dateAtRegexp)
  @IsOptional()
  createdStartAt?: string;

  @ApiPropertyOptional({
    description: '생성 끝 일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @Matches(dateAtRegexp)
  @IsOptional()
  createdEndAt?: string;

  @ApiProperty({
    description: '상품 코드',
  })
  // =================================
  @IsOptional()
  code?: string;

  @ApiPropertyOptional({
    description: '상품 이름',
  })
  // ================================
  @IsOptional()
  name?: string;

  @ApiProperty({
    description: '유효 기간 (일)',
  })
  // ================================
  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  expireDay?: number;

  @ApiProperty({
    description: '가격',
  })
  // =================================
  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  price?: number;
}

export class ProductChoiceGetDetailReqParamDto {
  @ApiProperty({
    description: '조회하고자 하는 상품 id',
  })
  // ======================================
  @IsNumber()
  @IsNotEmpty()
  @Type(() => Number)
  id: number;
}

export class ProductChoiceGetProductListReqQueryDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '브랜드 id',
  })
  // ================================
  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  brandId?: number;

  @ApiProperty({
    description: '상품군 ex) A,B,C,D',
  })
  // ================================
  @IsOptional()
  category?: string;

  @ApiProperty({
    description: '상품 사용 상태 ex) 사용: USE 미사용: UNUSED 영구 미사용: PERMANENTLY_UNUSED',
  })
  // =================================
  @IsEnum(IProductUseStatus)
  @IsOptional()
  useStatus?: IProductUseStatus;

  @ApiProperty({
    description: '상품 코드',
  })
  // =================================
  @IsOptional()
  code?: string;

  @ApiPropertyOptional({
    description: '상품 이름',
  })
  // ================================
  @IsOptional()
  name?: string;

  @ApiProperty({
    description: '유효 기간 (일)',
  })
  // ================================
  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  expireDay?: number;

  @ApiProperty({
    description: '가격',
  })
  // =================================
  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  price?: number;
}

export class ProductChoiceCreateReqDto {
  @ApiProperty({
    description: '상품명',
  })
  // ================================
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({
    description: '대표 이미지 path',
  })
  // ================================
  @IsOptional()
  imagePath?: string;

  @ApiProperty({
    description: '상품 pk 리스트',
  })
  // ================================
  @IsNumber({}, { each: true })
  @ArrayNotEmpty()
  @IsArray()
  productIdList: number[];

  @ApiProperty({
    description: '상품 사용 상태 ex) 사용: USE 미사용: UNUSED 영구 미사용: PERMANENTLY_UNUSED',
  })
  // ================================
  @IsNotEmpty()
  @IsEnum(IProductUseStatus)
  useStatus: IProductUseStatus;
}

export class ProductChoiceDeleteReqDto {
  @ApiProperty({
    description: '삭제할 초이스쿠폰 id 리스트',
  })
  // ================================
  @IsNumber({}, { each: true })
  @ArrayNotEmpty()
  @IsArray()
  idList: number[];
}

export class ProductChoiceUpdateReqDto {
  @ApiProperty({
    description: '수정 product id (초이스쿠폰)',
  })
  // =================================
  @IsNumber()
  @IsNotEmpty()
  id: number;

  @ApiProperty({
    description: '상품명',
  })
  // ================================
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    description: '대표 이미지 path',
  })
  // ================================
  @IsOptional()
  imagePath?: string;

  @ApiProperty({
    description: '상품 pk 리스트',
  })
  // ================================
  @IsNumber({}, { each: true })
  @ArrayNotEmpty()
  @IsArray()
  productIdList: number[];

  @ApiProperty({
    description: '상품 사용 상태 ex) 사용: USE 미사용: UNUSED 영구 미사용: PERMANENTLY_UNUSED',
  })
  // ================================
  @IsNotEmpty()
  @IsEnum(IProductUseStatus)
  useStatus: IProductUseStatus;
}
