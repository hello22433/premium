import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { IProductSettleMethod } from '../interface/product.settle.method';
import { IProductCategory, IProductType } from '../interface/product.type';
import { IProductUseStatus } from '../interface/product.status';
import { IsDivisibleBy5000 } from './validator/is-divisible-by-5000.validator';
import { PRODUCT_MEMO_MAX_LENGTH } from '../domain/ssg.notice';

export class ProductGetTotalListReqQueryDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '협력사 id',
  })
  // ================================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  partnerCompanyId?: number;

  @ApiPropertyOptional({
    description: '브랜드 id',
  })
  // ================================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  brandId?: number;

  @ApiPropertyOptional({
    description: '상품 타입 ',
  })
  // ================================
  @IsOptional()
  @IsEnum(IProductType)
  type?: IProductType;

  @ApiProperty({
    description: '초이스 쿠폰 같이 불러오기',
  })
  // =================================
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true')
  isChoiceType?: boolean;

  @ApiPropertyOptional({
    description: '브랜드 명 ',
  })
  // ================================
  @IsOptional()
  brandName?: string;

  @ApiPropertyOptional({
    description: '상품 이름',
  })
  // ================================
  @IsOptional()
  name?: string;

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

  @ApiProperty({
    description: '협력사 코드',
  })
  // =================================
  @IsOptional()
  partnerCompanyCode?: string;

  @ApiPropertyOptional({
    description: '통합 검색 키워드 (상품명, 상품코드, 협력사코드 OR 검색)',
  })
  // ================================
  @IsOptional()
  searchKeyword?: string;

  @ApiProperty({
    description: '찜한 상품 불러오기',
  })
  // =================================
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true') // 문자열을 boolean으로 변환
  isLike?: boolean;

  @ApiPropertyOptional({
    description: '상품 카테고리 ex) 모바일쿠폰: MOBILE_COUPON, 실물상품: REAL_PRODUCT',
  })
  // =================================
  @IsOptional()
  @IsEnum(IProductCategory)
  productCategory?: IProductCategory;

  // expireDayMin/Max 는 사용자가 직접 입력하는 값이 아니라 프론트의 유효기간 프리셋 상수로
  // 전송된다(예: 30일=29/31, 5년=1824/1826). 검증 메시지는 최종 사용자에게 노출될 일이 거의
  // 없고 프론트 개발자/직접 호출자 디버깅용이므로, 사용자 친화 문구일 필요는 없다.
  @ApiPropertyOptional({
    description: '유효기간(일) 하한 — 이 값 이상의 상품만 조회',
  })
  // ================================
  @IsOptional()
  @IsInt({ message: '유효기간 최소값은 정수로 입력해주세요.' })
  @Min(0, { message: '유효기간 최소값은 0일 이상으로 입력해주세요.' })
  @Type(() => Number)
  expireDayMin?: number;

  @ApiPropertyOptional({
    description: '유효기간(일) 상한 — 이 값 이하의 상품만 조회',
  })
  // ================================
  @IsOptional()
  @IsInt({ message: '유효기간 최대값은 정수로 입력해주세요.' })
  @Min(0, { message: '유효기간 최대값은 0일 이상으로 입력해주세요.' })
  @Type(() => Number)
  expireDayMax?: number;
}

export class ProductGetListReqQueryDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '협력사 id',
  })
  // ================================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  partnerCompanyId?: number;

  @ApiPropertyOptional({
    description: '기본 담당자 user.id',
  })
  // ================================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  headPersonUserId?: number;

  @ApiPropertyOptional({
    description: '브랜드 id',
  })
  // ================================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  brandId?: number;

  @ApiPropertyOptional({
    description: '상품 타입 ',
  })
  // ================================
  @IsOptional()
  @IsEnum(IProductType)
  type?: IProductType;

  @ApiProperty({
    description: '초이스 쿠폰 같이 불러오기',
  })
  // =================================
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true')
  isChoiceType?: boolean;

  @ApiPropertyOptional({
    description: '브랜드 명 ',
  })
  // ================================
  @IsOptional()
  brandName?: string;

  @ApiPropertyOptional({
    description: '상품 이름',
  })
  // ================================
  @IsOptional()
  name?: string;

  @ApiProperty({
    description: '상품 사용 상태 ex) 사용: USE 미사용: UNUSED 영구 미사용: PERMANENTLY_UNUSED',
  })
  // =================================
  @IsEnum(IProductUseStatus)
  @IsOptional()
  useStatus?: IProductUseStatus = IProductUseStatus.USE;

  @ApiProperty({
    description: '상품 코드',
  })
  // =================================
  @IsOptional()
  code?: string;

  @ApiProperty({
    description: '협력사 코드',
  })
  // =================================
  @IsOptional()
  partnerCompanyCode?: string;

  @ApiPropertyOptional({
    description: '통합 검색 키워드 (상품명, 상품코드, 협력사코드 OR 검색)',
  })
  // ================================
  @IsOptional()
  searchKeyword?: string;

  @ApiProperty({
    description: '찜한 상품 불러오기',
  })
  // =================================
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true') // 문자열을 boolean으로 변환
  isLike?: boolean;

  @ApiPropertyOptional({
    description: '상품 카테고리 ex) 모바일쿠폰: MOBILE_COUPON, 실물상품: REAL_PRODUCT',
  })
  // =================================
  @IsOptional()
  @IsEnum(IProductCategory)
  productCategory?: IProductCategory;

  // expireDayMin/Max 는 사용자가 직접 입력하는 값이 아니라 프론트의 유효기간 프리셋 상수로
  // 전송된다(예: 30일=29/31, 5년=1824/1826). 검증 메시지는 최종 사용자에게 노출될 일이 거의
  // 없고 프론트 개발자/직접 호출자 디버깅용이므로, 사용자 친화 문구일 필요는 없다.
  @ApiPropertyOptional({
    description: '유효기간(일) 하한 — 이 값 이상의 상품만 조회',
  })
  // ================================
  @IsOptional()
  @IsInt({ message: '유효기간 최소값은 정수로 입력해주세요.' })
  @Min(0, { message: '유효기간 최소값은 0일 이상으로 입력해주세요.' })
  @Type(() => Number)
  expireDayMin?: number;

  @ApiPropertyOptional({
    description: '유효기간(일) 상한 — 이 값 이하의 상품만 조회',
  })
  // ================================
  @IsOptional()
  @IsInt({ message: '유효기간 최대값은 정수로 입력해주세요.' })
  @Min(0, { message: '유효기간 최대값은 0일 이상으로 입력해주세요.' })
  @Type(() => Number)
  expireDayMax?: number;
}

export class ProductSsgReqQueryDto {
  @ApiProperty({
    description: '신세계 상품권 가격',
  })
  // ===========================
  @IsNotEmpty()
  @IsInt()
  @Type(() => Number)
  @Min(5000, { message: '금액은 최소 5,000원 이상이어야 합니다.' })
  @Max(2000000, { message: '금액은 최대 2,000,000원 이하여야 합니다.' })
  @IsDivisibleBy5000({ message: '금액은 5,000원 단위로 입력해야 합니다.' })
  price: number;
}

export class ProductGetDetailReqParamDto {
  @ApiProperty({
    description: '조회하고자 하는 상품 id',
  })
  // ======================================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;
}

export class ProductGetUpdateHistoryReqParamDto {
  @ApiProperty({
    description: '조회하고자 하는 상품 id',
  })
  // ======================================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;
}

export class ProductGetUpdateHistoryReqQueryDto extends PagingReqDto {}

export class ProductCreateReqDto {
  @ApiProperty({
    description: '협력사 상품 코드',
    required: false,
  })
  // ================================
  @IsOptional()
  partnerCompanyCode?: string;

  @ApiProperty({
    description: '협력사 partnerCompany.id',
  })
  // ================================
  @IsNotEmpty()
  @IsNumber()
  partnerCompanyId: number;

  @ApiProperty({
    description: '브랜드 brand.id',
  })
  // ================================
  @IsNotEmpty()
  @IsNumber()
  brandId: number;

  @ApiProperty({
    description: '상품명',
  })
  // ================================
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    description: '가격',
  })
  // ================================
  @IsNotEmpty()
  @IsNumber()
  price: number;

  @ApiProperty({
    description: '유효 기간 (일)',
  })
  // ================================
  @IsNotEmpty()
  @IsNumber()
  expireDay: number;

  @ApiPropertyOptional({
    description: 'GALAXIA cpn 유효기간 (일수, 1~999)',
    nullable: true,
  })
  // ================================
  @IsOptional()
  @IsNumber()
  galaxiaDuration?: number | null;

  @ApiProperty({
    description: '상품군 ex) A,B,C,D',
  })
  // ================================
  @IsNotEmpty()
  category: string;

  @ApiPropertyOptional({
    description: '대분류 classification.id',
  })
  // ================================
  @IsOptional()
  @IsNumber()
  classificationId?: number;

  @ApiProperty({
    description: '정산 방법 ex) 교환당 : PER_EXCHANGE, 발행당: PER_ISSUANCE, 상품당: PER_PRODUCT',
  })
  // ================================
  @IsNotEmpty()
  @IsIn(['PER_EXCHANGE', 'PER_ISSUANCE', 'PER_PRODUCT', 'PREPAID_INVENTORY'])
  settleMethod: IProductSettleMethod;

  @ApiProperty({
    description: '정산 조건 (퍼센트), ex) 30 = 30%',
  })
  // ================================
  @IsNotEmpty()
  @IsNumber()
  settlePercent: number;

  @ApiProperty({
    description: '미리보기 이미지 path',
  })
  // ================================
  @IsNotEmpty()
  imagePath: string;

  @ApiProperty({
    description: '상품유형 ex) 일반: GENERAL, 초이스: CHOICE, 배송: DELIVERY, 자체: SELF, 실물: REAL',
  })
  // ================================
  @IsNotEmpty()
  @IsEnum(IProductType)
  type: IProductType;

  @ApiPropertyOptional({
    nullable: true,
    description: '유의사항',
  })
  // ================================
  @IsOptional()
  memo: string | null;

  @ApiProperty({
    description: '상품 사용 상태 ex) 사용: USE 미사용: UNUSED 영구 미사용: PERMANENTLY_UNUSED',
  })
  // ================================
  @IsNotEmpty()
  @IsEnum(IProductUseStatus)
  useStatus: IProductUseStatus;
}

export class ProductUpdatePartialReqDto extends PartialType(ProductCreateReqDto) {
  @ApiProperty({
    description: '수정 product id',
  })
  // =================================
  @IsNotEmpty()
  @IsNumber()
  id: number;

  @ApiProperty({
    description: '수정 사유 ',
  })
  // =================================
  @IsOptional()
  reason?: string;
}

export class ProductExcelUploadReqDto {
  @ApiProperty({
    type: 'string',
    description: '업로드 하고자 하는 상품 엑셀파일',
    format: 'binary',
  })
  // =====================================================
  file: Express.Multer.File;
}

export class ProductSharedListUploadReqDto {
  @ApiProperty({
    type: 'string',
    description: '고객사 다운로드용으로 업로드 할 상품리스트 파일',
    format: 'binary',
  })
  file: Express.Multer.File;
}

export class ProductExcelDownloadReqBodyDto {
  @ApiPropertyOptional({
    description: '협력사 id',
  })
  // ================================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  partnerCompanyId?: number;

  @ApiPropertyOptional({
    description: '고객사 user.id',
  })
  // ================================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  userId?: number;

  @ApiPropertyOptional({
    description: '브랜드 id',
  })
  // ================================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  brandId?: number;

  @ApiPropertyOptional({
    description: '브랜드 명 ',
  })
  // ================================
  @IsOptional()
  brandName?: string;

  @ApiPropertyOptional({
    description: '상품 이름',
  })
  // ================================
  @IsOptional()
  name?: string;

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

  @ApiProperty({
    description: '협력사 코드',
  })
  // =================================
  @IsOptional()
  partnerCompanyCode?: string;

  @ApiProperty({
    description: '비밀번호 (다운로드 확인용)',
  })
  // =================================
  @IsNotEmpty()
  password: string;

  @ApiProperty({
    description: '다운로드 사유',
  })
  // =================================
  @IsNotEmpty()
  downloadReason: string;
}

export class ProductSetLikeReqDto {
  @ApiProperty({
    description: 'product id',
  })
  // =================================
  @IsNumber()
  @IsNotEmpty()
  productId: number;

  @ApiProperty({
    description: 'isLike',
  })
  // =================================
  @IsBoolean()
  @IsNotEmpty()
  isLike: boolean;
}

export class ProductDeleteReqDto {
  @ApiProperty({
    description: '삭제 할 product id list',
  })
  // ==================================
  @IsArray()
  @IsNotEmpty()
  @IsNumber({}, { each: true })
  idList: number[];
}

export class ClassificationGetSearchListReqDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '검색하고자 하는 대분류명',
  })
  // ========================================
  @IsOptional()
  searchText?: string;
}

export class ClassificationCreateReqDto {
  @ApiProperty({
    description: '대분류명',
  })
  // ========================================
  @IsNotEmpty()
  classification: string;
}

export class ProductSsgNoticeUpdateReqDto {
  @ApiProperty({
    description:
      '신세계 상품 유의사항 전문. 입력한 줄바꿈·빈 줄이 그대로 저장되며, 모든 신세계 권종에 동일하게 적용됩니다.',
  })
  // ================================
  @IsString()
  @IsNotEmpty()
  @MaxLength(PRODUCT_MEMO_MAX_LENGTH)
  notice: string;

  @ApiPropertyOptional({
    description: '수정 사유. 상품 수정 이력에 함께 기록됩니다.',
  })
  // ================================
  @IsOptional()
  @IsString()
  @MaxLength(512)
  reason?: string;
}

export class ProductGetLinkAverageExpireDayReqQueryDto {
  @ApiProperty({ description: '담당자 user.id' })
  // ================================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  headPersonUserId: number;
}
