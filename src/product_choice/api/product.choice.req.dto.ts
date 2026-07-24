import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';
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
      '검색 결과에서 제외할 상품 id 목록. 초이스쿠폰 등록 화면에서 이미 등록된 상품을 후보에서 빼기 위해 사용한다.<br>' +
      '콤마 구분(780,763,729) 또는 반복 파라미터(?id[]=780&id[]=763) 둘 다 허용한다. 콤마 형식을 권장한다.<br>' +
      '저장 전 편집분까지 반영해야 하므로 화면의 등록 목록을 그대로 전달한다.',
    type: String,
    example: '780,763,729',
  })
  // =================================
  @IsOptional()
  @Transform(
    ({ value }) => {
      if (value === undefined || value === null || value === '') {
        return undefined;
      }
      // 콤마 구분 문자열(780,763)과 반복 파라미터(?id[]=780&id[]=763) 양쪽을 모두 허용한다.
      // 반복 파라미터는 21건부터 express 기본 쿼리 파서(qs)의 arrayLimit(20)에 걸려
      // 배열이 아니라 객체({'0':'780','1':'763'})로 도착하므로 객체도 함께 받아야 한다.
      // (이 분기가 없으면 등록 상품 21건 이상인 초이스쿠폰의 상품검색이 전부 400 이 된다)
      const rawList = Array.isArray(value)
        ? value
        : typeof value === 'object'
          ? Object.values(value as Record<string, unknown>)
          : String(value).split(',');
      // 잘못된 값은 조용히 버리지 않고 NaN 으로 남겨 IsInt 검증에서 400 으로 드러나게 한다.
      const idList = rawList.map((raw) => {
        const trimmed = String(raw).trim();
        return trimmed === '' ? Number.NaN : Number(trimmed);
      });
      return idList.length > 0 ? [...new Set(idList)] : undefined;
    },
    // 요청 쿼리 → 클래스 변환에만 적용한다. (모듈 내 요청 DTO 변환 관례와 동일)
    { toClassOnly: true },
  )
  // IsInt/Min 의 each 옵션은 값이 배열이 아니면 아무 검증도 하지 않고 통과시키므로,
  // 배열 보장은 IsArray 가 맡는다. (모듈 내 productIdList/idList 와 동일한 조합)
  @IsArray()
  // 초대형 IN 절과, 거부 시 id 를 전부 나열하는 400 메시지가 폭발하는 것을 막는다.
  // 실질 도달 불가한 상한이라 편집 화면 진입을 막지 않으면서, 방어선을 인프라(URL 길이 제한)가
  // 아닌 애플리케이션 계층에 둔다. (refund.req.dto 와 동일한 값)
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  @Min(1, { each: true })
  // product.id 는 int(11)(부호 있는 32비트)이라 이보다 큰 값은 어차피 매칭 0건이다.
  // 상한을 명시해 '1e21' 같은 표기가 IsInt 를 통과해 흘러드는 것을 막는다.
  @Max(2147483647, { each: true })
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
