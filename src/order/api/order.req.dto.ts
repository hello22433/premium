import { IOrderStatus } from '../interface/order.status';
import { IsArray, IsEnum, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { dateAtRegexp } from '../../common/domain/date.regexp';
import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { OrderCreateDto } from './dto/order.create.dto';
import { IOrderType } from '../interface/order.type';
import { IOrderSection } from '../interface/order.section';
import { Type } from 'class-transformer';
import { OrderSettleCreateDto } from './dto/order.settle.create.dto';
import { IOrderSendMethod } from '../interface/order.send.method';

export class OrderGetListReqDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '구분 ex) 주문관리 : ORDER, 발송관리: SHIPPING',
    default: IOrderSection.ORDER,
  })
  // ==============================================
  @IsEnum(IOrderSection)
  section: IOrderSection = IOrderSection.ORDER;

  @ApiProperty({
    description: '주문 타입 ex) 일반: GENERAL, 신세계: SSG, 맞춤형: CUSTOM',
    default: 'GENERAL',
  })
  // ==============================================
  @IsEnum(IOrderType)
  type: IOrderType = IOrderType.GENERAL;

  @ApiPropertyOptional({
    description:
      '발송 상태 <br>' +
      'TEMP : 임시 저장<br>' +
      '  DELIVERY_REQUEST : 발송 요청 = 주문완료<br>' +
      '  DELIVERY_CONFIRMED : 발송 대기 = 발송 확정<br>' +
      '  DELIVERY_COMPLETE : 발송 완료<br>' +
      '  DELIVERY_CANCEL : 발송 취소`',
  })
  // ===================================
  @IsOptional()
  @IsEnum(IOrderStatus)
  status?: IOrderStatus;

  @ApiPropertyOptional({
    description: '발송 시간 조회 시작 날짜 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // ===================================
  @IsOptional()
  @Matches(dateAtRegexp)
  startAt?: string;

  @ApiPropertyOptional({
    description: '발송 시간 조회 끝 날짜 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // ===================================
  @IsOptional()
  @Matches(dateAtRegexp)
  endAt?: string;

  @ApiPropertyOptional({
    description: '검색조건 ex) ALL: 전체, CUSTOMER: 고객사, MANAGER: 담당자, EVENT: 이벤트명, PRODUCT: 상품명',
    enum: ['ALL', 'CUSTOMER', 'MANAGER', 'EVENT', 'PRODUCT'],
    default: 'ALL',
  })
  // ===================================
  @IsOptional()
  @IsEnum(['ALL', 'CUSTOMER', 'MANAGER', 'EVENT', 'PRODUCT'])
  searchType?: 'ALL' | 'CUSTOMER' | 'MANAGER' | 'EVENT' | 'PRODUCT' = 'ALL';

  @ApiPropertyOptional({
    description: '검색어 (최소 1자)',
  })
  // ===================================
  @IsOptional()
  searchKeyword?: string;
}

export class OrderCreateTempReqDto extends OrderCreateDto {
  @ApiProperty({
    description: '주문 타입 ex) 일반: GENERAL, 신세계: SSG, 맞춤형: CUSTOM',
    default: 'GENERAL',
  })
  // ==============================================
  @IsEnum(IOrderType)
  type: IOrderType;
}

export class OrderGetDetailReqParamDto {
  @ApiProperty({
    description: 'order id',
  })
  // ==============================================
  @IsNumber()
  @IsNotEmpty()
  @Type(() => Number)
  id: number;
}

export class OrderGetDeliveryCompleteReportReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ==============================================
  @IsNumber()
  @Type(() => Number)
  id: number;
}

export class OrderGetDeliveryCompleteReportPdfReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ==============================================
  @IsNumber()
  @IsNotEmpty()
  id: number;

  @ApiProperty({
    description: '발행 소스 ex) DOCUMENT: 문서함, DIRECT: 직접발행',
    required: false,
  })
  @IsOptional()
  @IsString()
  source?: string;
}

export class OrderGetOrderCompleteReportReqDto extends OrderGetDeliveryCompleteReportReqDto {}

export class OrderGetOrderCompleteReportPdfReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ==============================================
  @IsNumber()
  @IsNotEmpty()
  id: number;

  @ApiProperty({
    description: '발행 소스 ex) DOCUMENT: 문서함, DIRECT: 직접발행',
    required: false,
  })
  @IsOptional()
  @IsString()
  source?: string;
}

export class OrderGetSettleReqDto extends PagingReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ==============================================
  @IsNumber()
  @IsNotEmpty()
  @Type(() => Number)
  id: number;
}

export class OrderCreateSettleReqDto {
  @ApiProperty({
    description: '정산 정보 입력 목록 list',
  })
  @IsArray()
  // =============================
  list: OrderSettleCreateDto[];
}

export class OrderUpdateSettleReqDto extends OrderCreateSettleReqDto {}

export class OrderUpdateTempReqDto extends OrderCreateDto {
  @ApiProperty({
    description: 'order id',
  })
  // =============================
  @IsNumber()
  @IsNotEmpty()
  id: number;
}

export class OrderDeleteTempReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // =============================
  @IsNumber()
  @IsNotEmpty()
  id: number;
}

export class OrderDeliveryRequestReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ==================================
  @IsNotEmpty()
  @IsNumber()
  id: number;
}

export class OrderDeliveryConfirmedReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ==================================
  @IsNotEmpty()
  @IsNumber()
  id: number;
}

export class OrderDeliverySsgCouponExpireChangeReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ==================================
  @IsNotEmpty()
  @IsNumber()
  id: number;

  @ApiProperty({
    description: '신세계 상품 유효 기간',
  })
  // ==================================
  @IsNotEmpty()
  @IsNumber()
  @IsIn([60, 90, 180])
  couponExpiration: number;
}

export class OrderDeliveryCancelReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ==================================
  @IsNotEmpty()
  @IsNumber()
  id: number;

  @ApiProperty({
    description: '주문 취소 사유',
  })
  // ==================================
  @IsNotEmpty()
  @IsString()
  @MaxLength(1000)
  cancelReason: string;
}

export class OrderUpdateOperationUserReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ==================================
  @IsNotEmpty()
  @IsNumber()
  id: number;

  @ApiProperty({
    description: '운영 담당자 지정 user id',
  })
  // ==================================
  @IsNotEmpty()
  @IsNumber()
  operationUserId: number;
}

export class OrderExcelDownloadReqBodyDto {
  @ApiPropertyOptional({
    description: '구분 ex) 주문관리 : ORDER, 발송관리: SHIPPING',
    default: IOrderSection.ORDER,
  })
  // ==============================================
  @IsEnum(IOrderSection)
  section: IOrderSection = IOrderSection.ORDER;

  @ApiProperty({
    description: '주문 타입 ex) 일반: GENERAL, 신세계: SSG',
    default: 'GENERAL',
  })
  // ==============================================
  @IsEnum(IOrderType)
  type: IOrderType = IOrderType.GENERAL;

  @ApiPropertyOptional({
    description:
      '발송 상태 <br>' +
      'TEMP : 임시 저장<br>' +
      '  DELIVERY_REQUEST : 발송 요청 = 주문완료<br>' +
      '  DELIVERY_CONFIRMED : 발송 대기 = 발송 확정<br>' +
      '  DELIVERY_COMPLETE : 발송 완료<br>' +
      '  DELIVERY_CANCEL : 발송 취소`',
  })
  // ===================================
  @IsOptional()
  @IsEnum(IOrderStatus)
  status?: IOrderStatus;

  @ApiPropertyOptional({
    description: '발송 시간 조회 시작 날짜 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // ===================================
  @IsOptional()
  @Matches(dateAtRegexp)
  startAt?: string;

  @ApiPropertyOptional({
    description: '발송 시간 조회 끝 날짜 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // ===================================
  @IsOptional()
  @Matches(dateAtRegexp)
  endAt?: string;

  @ApiPropertyOptional({
    description: '검색조건 ex) ALL: 전체, CUSTOMER: 고객사, MANAGER: 담당자, EVENT: 이벤트명, PRODUCT: 상품명',
    enum: ['ALL', 'CUSTOMER', 'MANAGER', 'EVENT', 'PRODUCT'],
    default: 'ALL',
  })
  // ===================================
  @IsOptional()
  @IsEnum(['ALL', 'CUSTOMER', 'MANAGER', 'EVENT', 'PRODUCT'])
  searchType?: 'ALL' | 'CUSTOMER' | 'MANAGER' | 'EVENT' | 'PRODUCT' = 'ALL';

  @ApiPropertyOptional({
    description: '검색어 (최소 1자)',
  })
  // ===================================
  @IsOptional()
  searchKeyword?: string;

  @ApiProperty({
    description: '비밀번호 (다운로드 확인용)',
  })
  // ===================================
  @IsNotEmpty()
  password: string;

  @ApiProperty({
    description: '다운로드 사유',
  })
  // ===================================
  @IsNotEmpty()
  downloadReason: string;
}

export class OrderTestDeliveryReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ===================================
  @IsNumber()
  @IsNotEmpty()
  orderId: number;

  @ApiProperty({
    description: 'order product mapping id',
  })
  // ===================================
  @IsNumber()
  @IsNotEmpty()
  orderProductMappingId: number;

  @ApiProperty({
    description: '수신 대상',
  })
  // ===================================
  @IsNotEmpty()
  deliveryTarget: string;
}

export class OrderGetPreviousContentReqQueryDto {
  @ApiProperty({
    description: 'order id',
  })
  // ===================================
  @IsNumber()
  @IsNotEmpty()
  @Type(() => Number)
  orderId: number;

  @ApiProperty({
    description: 'product id',
  })
  // ===================================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  productId?: number;
}

export class OrderUpdateEncourageDayReqParamDto {
  @ApiProperty({
    description: 'order_product_mapping id (상품별 설정)',
  })
  // ===================================
  @IsNumber()
  @IsNotEmpty()
  @Type(() => Number)
  id: number;
}

export class OrderUpdateEncourageDayReqBodyDto {
  @ApiPropertyOptional({
    description: '독려 문자 day (null이면 미사용)',
  })
  // ===================================
  @IsOptional()
  @IsNumber()
  encourageDay: number | null;
}

export class OrderUpdateTailTextReqParamDto {
  @ApiProperty({
    description: 'order_product_mapping id (상품별 설정)',
  })
  // ===================================
  @IsNumber()
  @IsNotEmpty()
  @Type(() => Number)
  id: number;
}

export class OrderUpdateTailTextReqBodyDto {
  @ApiPropertyOptional({
    description: '꼬리 광고 text (null 또는 빈 문자열이면 미사용)',
  })
  // ===================================
  @IsOptional()
  @IsString()
  @MaxLength(100)
  sendTailText: string | null;
}

export class OrderUpdateUseEmailContentReqParamDto {
  @ApiProperty({
    description: 'order_product_mapping id (상품별 설정)',
  })
  // ===================================
  @IsNumber()
  @IsNotEmpty()
  @Type(() => Number)
  id: number;
}

export class OrderUpdateUseEmailContentReqBodyDto {
  @ApiProperty({
    description: '이메일 사용방법',
  })
  // ===================================
  @IsNotEmpty()
  @IsString()
  useEmailContent: string;
}
