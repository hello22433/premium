import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, Matches, Min } from 'class-validator';
import { IProductUseStatus } from '../../product/interface/product.status';
import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { Transform, Type } from 'class-transformer';
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

  @ApiPropertyOptional({
    description:
      '검색 결과에서 제외할 상품 id 목록 (콤마 구분) ex) 780,763,729<br>' +
      '초이스쿠폰 등록 화면에서 이미 등록된 상품을 후보에서 빼기 위해 사용한다. ' +
      '저장 전 편집분까지 반영해야 하므로 화면의 등록 목록을 그대로 전달한다.',
    type: String,
    example: '780,763,729',
  })
  // =================================
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    // 콤마 구분 문자열(780,763)과 반복 파라미터(?id=780&id=763) 양쪽을 모두 허용한다.
    const rawList = Array.isArray(value) ? value : String(value).split(',');
    // 잘못된 값은 조용히 버리지 않고 NaN 으로 남겨 IsInt 검증에서 400 으로 드러나게 한다.
    const idList = rawList.map((raw) => {
      const trimmed = String(raw).trim();
      return trimmed === '' ? Number.NaN : Number(trimmed);
    });
    return idList.length > 0 ? [...new Set(idList)] : undefined;
  })
  @IsInt({ each: true })
  @Min(1, { each: true })
  excludeProductIdList?: number[];
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
