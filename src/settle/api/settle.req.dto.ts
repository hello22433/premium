import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';
import { dateAtRegexp, dateRegexp } from '../../common/domain/date.regexp';
import { Transform, Type } from 'class-transformer';
import { IPartnerCompanySettleMethod } from '../../partner_company/interface/partner.company.settle.method';
import { IShippingStorageType } from '../../entity/shipping.storage.entity';
import { SettleUserStatusEnum } from '../interface/settle.user.status';
import { SettleUserOrderDetailEnum } from '../interface/settle.user.order.detail';

export class SettleGetOtherServiceSaleGetListReqDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '등록일자 시작일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateAtRegexp)
  startAt?: string;

  @ApiPropertyOptional({
    description: '등록일자 끝 일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateAtRegexp)
  endAt?: string;

  @ApiPropertyOptional({
    description: '증빙일자 시작일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateAtRegexp)
  proveStartAt?: string;

  @ApiPropertyOptional({
    description: '증빙일자 끝 일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateAtRegexp)
  proveEndAt?: string;

  @ApiPropertyOptional({
    description: '부가세 적용 여부',
  })
  // =============================================================
  @IsOptional()
  isVat?: boolean;

  @ApiPropertyOptional({
    description: '고객사 명 ',
  })
  // =============================================================
  @IsOptional()
  businessName?: string;

  @ApiPropertyOptional({
    description: '담당자 명 ',
  })
  // =============================================================
  @IsOptional()
  personName?: string;

  @ApiPropertyOptional({
    description: '이벤트 명 ',
  })
  // =============================================================
  @IsOptional()
  eventName?: string;

  @ApiPropertyOptional({
    description: '품목명',
  })
  // =============================================================
  @IsOptional()
  productName?: string;
}

export class SettleGetOtherServiceSaleGetDetailReqParamDto {
  @ApiProperty({
    description: 'other service sale id',
  })
  // =============================================================
  @Min(1)
  @Type(() => Number)
  @IsInt()
  id: number;
}

export class SettleCreateOtherSaleReqDto {
  @ApiProperty({
    description: '고객사 담당자 id',
  })
  // =============================================================
  @IsNotEmpty()
  @IsNumber()
  businessUserId: number;

  @ApiProperty({
    description: '부가세적용여부 ex) true: 적용',
  })
  // =============================================================
  @IsNotEmpty()
  @IsBoolean()
  isVat: boolean;

  @ApiProperty({
    description: '출하창고 id',
  })
  // =============================================================
  @IsNotEmpty()
  @IsNumber()
  shippingStorageId: number;

  @ApiProperty({
    description: '담당자 id',
  })
  // =============================================================
  @IsNotEmpty()
  @IsNumber()
  userId: number;

  @ApiProperty({
    description: '판매유형 id',
  })
  // =============================================================
  @IsNotEmpty()
  @IsNumber()
  saleTypeId: number;

  @ApiProperty({
    description: '증빙일자',
  })
  // =============================================================
  @IsNotEmpty()
  @Matches(dateRegexp)
  proveAt: string;

  @ApiProperty({
    description: '이벤트 명',
  })
  // =============================================================
  @IsNotEmpty()
  eventName: string;

  @ApiProperty({
    description: '이벤트 상세',
  })
  // =============================================================
  @IsNotEmpty()
  eventContent: string;

  @ApiPropertyOptional({
    description: '특이사항',
  })
  // =============================================================
  @IsOptional()
  etc: string;

  @ApiProperty({
    description: '상품 정보 리스트',
  })
  @IsArray()
  @Type(() => SettleOtherProductDto)
  productList: SettleOtherProductDto[];
}

export class SettlerUpdateOtherSaleReqDto {
  @ApiProperty({ description: '수정할 기타 서비스 매출 id' })
  @IsInt()
  @Min(1)
  saleId: number;

  @ApiProperty({ description: '고객사 담당자 id' })
  @IsNotEmpty()
  @IsInt()
  businessUserId: number;

  @ApiProperty({ description: '담당자 id' })
  @IsNotEmpty()
  @IsInt()
  userId: number;

  @ApiProperty({ description: '출하창고 id' })
  @IsNotEmpty()
  @IsInt()
  shippingStorageId: number;

  @ApiProperty({ description: '판매유형 id' })
  @IsNotEmpty()
  @IsInt()
  saleTypeId: number;

  @ApiProperty({ description: '부가세 적용 여부 ex) true: 적용' })
  @IsNotEmpty()
  @IsBoolean()
  isVat: boolean;

  @ApiProperty({ description: '이벤트 명' })
  @IsNotEmpty()
  @IsString()
  eventName: string;

  @ApiProperty({ description: '이벤트 상세정보' })
  @IsNotEmpty()
  @IsString()
  eventContent: string;

  @ApiProperty({ description: '특이사항' })
  @IsNotEmpty()
  @IsString()
  etc: string;

  @ApiProperty({ description: '증빙일자 ex) yyyy-MM-dd' })
  @IsNotEmpty()
  @Matches(dateRegexp)
  proveAt: string;

  @ApiPropertyOptional({
    description: '상품 매핑 리스트 (수정 또는 추가)',
  })
  @IsOptional()
  @IsArray()
  @Type(() => SettleUpdateProductDto)
  productList?: SettleUpdateProductDto[];

  @ApiPropertyOptional({
    description: '삭제할 상품 매핑 id 리스트',
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  deleteMappingIds?: number[];
}

export class SettleUpdateProductDto {
  @ApiPropertyOptional({ description: '매핑 id (가 있으면 수정)' })
  mappingId?: number;

  @ApiProperty({ description: '품목 코드' })
  code: string;

  @ApiProperty({ description: '브랜드 명' })
  brandName: string;

  @ApiProperty({ description: '품목명' })
  productName: string;

  @ApiProperty({ description: '단가' })
  price: number;

  @ApiProperty({ description: '수량' })
  quantity: number;

  @ApiProperty({ description: '공급가(수량 x 단가)' })
  totalPrice: number;
}

export class SettleOtherProductDto {
  @ApiPropertyOptional({ description: '매핑 id (가 있으면 수정)' })
  @IsOptional()
  @IsInt()
  mappingId?: number;

  @ApiProperty({ description: '품목 코드' })
  @IsNotEmpty()
  @IsString()
  code: string;

  @ApiProperty({ description: '브랜드 명' })
  @IsNotEmpty()
  @IsString()
  brandName: string;

  @ApiProperty({ description: '품목명' })
  @IsNotEmpty()
  @IsString()
  productName: string;

  @ApiProperty({ description: '단가' })
  @IsNotEmpty()
  @IsNumber()
  @Min(1)
  price: number;

  @ApiProperty({ description: '수량' })
  @IsNotEmpty()
  @IsInt()
  @Min(1)
  quantity: number;

  @ApiProperty({ description: '공급가(수량 x 단가)' })
  @IsNotEmpty()
  @IsNumber()
  @Min(1)
  totalPrice: number;
}

export class SettleGetShippingStorageListReqDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '검색어 ',
  })
  // =============================================================
  @IsOptional()
  searchText?: string;
}

export class SettleGetSaleTypeListReqDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '검색어 ',
  })
  // =============================================================
  @IsOptional()
  searchText?: string;
}

export class SettleGetAdminListReqDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '검색어(이름, 이메일, 회사명)',
  })
  // =============================================================
  @IsOptional()
  searchText?: string;
}

export class SettleCreateShippingStorageReqDto {
  @ApiProperty({ description: '창고 코드' })
  @IsNotEmpty()
  code: string;

  @ApiProperty({
    description: '창고 타입 ex) STORAGE: 창고, FACTORY: 공장, OUTSOURCING_FACTORY: 공장(외주비관리)',
    enum: IShippingStorageType,
  })
  @IsEnum(IShippingStorageType)
  type: IShippingStorageType;

  @ApiProperty({ description: '창고 이름' })
  @IsNotEmpty()
  name: string;
}

export class SettleCreateSaleTypeReqDto {
  @ApiProperty({ description: '판매유형 코드' })
  @IsNotEmpty()
  code: string;

  @ApiProperty({ description: '판매유형 이름' })
  @IsNotEmpty()
  name: string;
}

export class SettleGetMobileListReqQueryDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '시작일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateAtRegexp)
  startAt?: string;

  @ApiPropertyOptional({
    description: '끝 일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateAtRegexp)
  endAt?: string;

  @ApiPropertyOptional({
    description: '고객사 명 ',
  })
  // =============================================================
  @IsOptional()
  businessName?: string;

  @ApiPropertyOptional({
    description: '담당자 명 ',
  })
  // =============================================================
  @IsOptional()
  personName?: string;

  @ApiPropertyOptional({
    description: '이벤트 명 ',
  })
  // =============================================================
  @IsOptional()
  eventName?: string;
}

export class SettleMobileExcelDownloadReqDto {
  @ApiPropertyOptional({
    description: '시작일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateAtRegexp)
  startAt?: string;

  @ApiPropertyOptional({
    description: '끝 일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateAtRegexp)
  endAt?: string;

  @ApiPropertyOptional({
    description: '고객사 명 ',
  })
  // =============================================================
  @IsOptional()
  businessName?: string;

  @ApiPropertyOptional({
    description: '담당자 명 ',
  })
  // =============================================================
  @IsOptional()
  personName?: string;

  @ApiPropertyOptional({
    description: '이벤트 명 ',
  })
  // =============================================================
  @IsOptional()
  eventName?: string;
}

export class SettleGetPartnerCompanyListReqQueryDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '시작일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateAtRegexp)
  startAt?: string;

  @ApiPropertyOptional({
    description: '끝 일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateAtRegexp)
  endAt?: string;

  @ApiPropertyOptional({
    description: '정산방법',
    enum: IPartnerCompanySettleMethod,
  })
  // =============================================================
  @IsOptional()
  @IsEnum(IPartnerCompanySettleMethod)
  settleMethod?: IPartnerCompanySettleMethod;

  @ApiPropertyOptional({
    description: '협력사 명 ',
  })
  // =============================================================
  @IsOptional()
  businessName?: string;
}

export class SettleGetUserListReqQueryDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '시작일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateAtRegexp)
  startAt?: string;

  @ApiPropertyOptional({
    description: '끝 일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateAtRegexp)
  endAt?: string;

  @ApiPropertyOptional({
    description: '발행 : true, 미발행 : false',
  })
  // =============================================================
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true') // 문자열을 boolean으로 변환
  isPublished?: boolean;

  @ApiPropertyOptional({
    description: '고객사 명 (사업자 명)',
  })
  // =============================================================
  @IsOptional()
  businessName?: string;

  @ApiPropertyOptional({
    description: '담당자 명',
  })
  // =============================================================
  @IsOptional()
  personName?: string;

  @ApiPropertyOptional({
    description: '이벤트 명',
  })
  // =============================================================
  @IsOptional()
  eventName?: string;
}

export class SettleGetUserDetailReqParamDto {
  @ApiProperty({
    description: 'order id',
  })
  // ======================================
  @Type(() => Number)
  @Min(1)
  @IsInt()
  orderId: number;
}

export class SettleGetUserExcelDownloadReqDto {
  @ApiPropertyOptional({
    description: '시작일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateAtRegexp)
  startAt?: string;

  @ApiPropertyOptional({
    description: '끝 일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateAtRegexp)
  endAt?: string;

  @ApiPropertyOptional({
    description: '발행 : true, 미발행 : false',
  })
  // =============================================================
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true')
  isPublished?: boolean;

  @ApiPropertyOptional({
    description: '고객사 명 (사업자 명)',
  })
  // =============================================================
  @IsOptional()
  businessName?: string;

  @ApiPropertyOptional({
    description: '담당자 명',
  })
  // =============================================================
  @IsOptional()
  personName?: string;

  @ApiPropertyOptional({
    description: '이벤트 명',
  })
  // =============================================================
  @IsOptional()
  eventName?: string;
}

export class SettleGetUserPerListReqQueryDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '조회 시작 시각',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateAtRegexp)
  startAt?: string;

  @ApiPropertyOptional({
    description: '조회 종료 시각',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateAtRegexp)
  endAt?: string;

  @ApiPropertyOptional({
    description: '고객사 명',
  })
  // =============================================================
  @IsOptional()
  userBusinessName?: string;

  @ApiPropertyOptional({
    description: '담당자 명',
  })
  // =============================================================
  @IsOptional()
  userPersonName?: string;

  @ApiPropertyOptional({
    description: '상태',
  })
  // =============================================================
  @IsOptional()
  @IsEnum(SettleUserStatusEnum)
  status?: SettleUserStatusEnum;
}

export class SettleGetUserPerDetailReqQueryDto extends PagingReqDto {
  @ApiProperty({
    description: 'user id',
  })
  // =============================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  userId: number;

  @ApiPropertyOptional({
    description: '조회 시작 시각',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateAtRegexp)
  startAt?: string;

  @ApiPropertyOptional({
    description: '조회 종료 시각',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateAtRegexp)
  endAt?: string;

  @ApiPropertyOptional({
    description: '고객사 명',
  })
  // =============================================================
  @IsOptional()
  userBusinessName?: string;

  @ApiPropertyOptional({
    description: '담당자 명',
  })
  // =============================================================
  @IsOptional()
  userPersonName?: string;

  @ApiPropertyOptional({
    description:
      '정산 상태 ex) UNSETTLE_OVERDUE: 미정산(초과), UNSETTLE_NORMAL:미정산(정상), SETTLE_COMPLETE: 정산완료',
  })
  // =============================================================
  @IsOptional()
  @IsEnum(SettleUserOrderDetailEnum)
  settleStatus?: SettleUserOrderDetailEnum;
}

export class SettleUpdateUserPerOrderReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // =============================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  orderId: number;

  @ApiPropertyOptional({
    description:
      '정산 상태 ex) UNSETTLE_OVERDUE: 미정산(초과), UNSETTLE_NORMAL:미정산(정상), SETTLE_COMPLETE: 정산완료',
  })
  // =============================================================
  @IsNotEmpty()
  @IsEnum(SettleUserOrderDetailEnum)
  settleStatus: SettleUserOrderDetailEnum;
}
