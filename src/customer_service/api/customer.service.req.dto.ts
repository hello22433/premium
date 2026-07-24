import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IOrderType } from '../../order/interface/order.type';
import {
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { dateAtRegexp } from '../../common/domain/date.regexp';
import { Type } from 'class-transformer';
import { OrderDeliveryCouponStatus } from 'src/delivery/interface/order.delivery.coupon.status';

export class CustomerServiceGetListReqDto extends PagingReqDto {
  @ApiPropertyOptional({
    type: Number,
    default: 10,
    description: '가져오고자 하는 데이터 개수 (최대 500)',
  })
  // =============================================================
  @IsOptional()
  @Min(1)
  @Max(500)
  @Type(() => Number)
  take: number = 10;

  @ApiProperty({
    description: '일반 쿠폰주문 CS: GENERAL, 신세계 :SSG',
  })
  // =============================================================
  @IsNotEmpty()
  @IsIn(['GENERAL', 'SSG'])
  orderType: IOrderType;

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
    description: '고객사 ID (user_company.id)',
  })
  // =============================================================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  userCompanyId?: number;

  @ApiPropertyOptional({
    description: '핀 상태',
    enum: OrderDeliveryCouponStatus,
  })
  // =============================================================
  @IsOptional()
  @IsEnum(OrderDeliveryCouponStatus)
  couponStatus?: OrderDeliveryCouponStatus;

  @ApiPropertyOptional({
    description: '주문 번호 (부분검색)',
  })
  // =============================================================
  @IsOptional()
  @IsString()
  orderNumber?: string;

  @ApiPropertyOptional({
    description: '상품 코드 (부분검색)',
  })
  // =============================================================
  @IsOptional()
  @IsString()
  productCode?: string;

  @ApiPropertyOptional({
    description: '상품 명 (부분검색)',
  })
  // =============================================================
  @IsOptional()
  @IsString()
  productName?: string;

  @ApiPropertyOptional({
    description: '수신정보 - 전화번호 또는 이메일 (전문검색, 부분검색 불가)',
  })
  // =============================================================
  @IsOptional()
  @IsString()
  deliveryTarget?: string;

  @ApiPropertyOptional({
    description: 'MMS 제목 (부분검색)',
  })
  // =============================================================
  @IsOptional()
  @IsString()
  sendTitle?: string;

  @ApiPropertyOptional({
    description: '협력사 ID',
  })
  // =============================================================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  partnerCompanyId?: number;

  @ApiPropertyOptional({
    description: '핀번호 검색 (barCode, personalCode OR 조건 부분검색)',
  })
  // =============================================================
  @IsOptional()
  @IsString()
  barCode?: string;

  @ApiPropertyOptional({
    description: '통합검색 키워드 (주문번호, 상품명, 상품코드, MMS제목, 수신정보, 이벤트명을 OR 조건으로 검색)',
  })
  // =============================================================
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional({
    description: '이벤트명 (부분검색)',
  })
  // =============================================================
  @IsOptional()
  @IsString()
  eventName?: string;

  // expireDayMin/Max 는 사용자가 직접 입력하는 값이 아니라 프론트의 유효기간 프리셋
  // (30일=29/31, 60일=59/61, 5년=1824/1826 등) 상수로 전송된다 (product.req.dto.ts 와 동일 컨벤션)
  @ApiPropertyOptional({
    description: '유효기간(일) 하한 — 이 값 이상의 유효기간 상품 발송 건만 조회',
  })
  // =============================================================
  @IsOptional()
  @IsInt({ message: '유효기간 최소값은 정수로 입력해주세요.' })
  @Min(0, { message: '유효기간 최소값은 0일 이상으로 입력해주세요.' })
  @Type(() => Number)
  expireDayMin?: number;

  @ApiPropertyOptional({
    description: '유효기간(일) 상한 — 이 값 이하의 유효기간 상품 발송 건만 조회',
  })
  // =============================================================
  @IsOptional()
  @IsInt({ message: '유효기간 최대값은 정수로 입력해주세요.' })
  @Min(0, { message: '유효기간 최대값은 0일 이상으로 입력해주세요.' })
  @Type(() => Number)
  expireDayMax?: number;
}

export class CustomerServiceGetDetailListReqDto extends PagingReqDto {
  @ApiProperty({
    description: 'orderId',
  })
  // =============================================================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  orderId: number;
}

export class CustomerServiceGetDetailReqDto {
  @ApiProperty({
    description: '일반쿠폰주문CS 변경내역 조회 reqDto',
  })
  // =============================================================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  orderDeliveryId: number;
}

export class UpdateCouponStatusReqDto {
  @ApiProperty({
    description: 'order delivery id',
  })
  // ========================================
  @IsNotEmpty()
  @IsNumber()
  orderDeliveryId: number;

  @ApiProperty({
    description: '핀 상태',
    enum: OrderDeliveryCouponStatus,
  })
  couponStatus: OrderDeliveryCouponStatus;
}

export class CustomerServiceReSendReqDto {
  @ApiProperty({ description: '재전송 하고자 하는 order Delivery id' })
  // =============================================================
  @IsNotEmpty()
  @IsNumber()
  orderDeliveryId: number;
}

export class CustomerServiceDiscardReqDto {
  @ApiProperty({ description: '핀폐기 하고자 하는 order Delivery id' })
  // =============================================================
  @IsNotEmpty()
  @IsNumber()
  orderDeliveryId: number;

  @ApiProperty({
    description: '핀 상태',
    enum: OrderDeliveryCouponStatus,
  })
  couponStatus: OrderDeliveryCouponStatus;
}

export class CustomerServiceCouponRefreshReqDto {
  @ApiProperty({ example: 241, description: '핀 새로고침 하고자 하는 orderDelivery.id' })
  @IsInt()
  @Min(1)
  @Type(() => Number)
  orderDeliveryId: number;
}

export class CustomerServicePinStatusModifyReqDto {
  @ApiProperty({ description: '핀상태변경 API' })
  // =============================================================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  orderDeliveryId: number;

  @ApiProperty({
    description: '변경내역 후 (핀상태: CANCEL=폐기 / REFUND_CANCEL=환불폐기)',
    enum: OrderDeliveryCouponStatus,
  })
  // =================================
  @IsOptional()
  @IsEnum(OrderDeliveryCouponStatus)
  afterChange?: OrderDeliveryCouponStatus;
}

export class CustomerServicePinStatusRefreshReqDto {
  @ApiProperty({ description: '핀상태갱신 API' })
  // =============================================================
  @IsNotEmpty()
  @IsNumber()
  orderDeliveryId: number;
}

/**
 * CS 이력(order_history) 유형 named 상수 (D3-37).
 * switch case / 비교문에서 이 객체를 참조해 리터럴 중복을 제거한다.
 * ('핀상태 변경'은 별도 엔드포인트(pin-status/modify) 소관이라 제외)
 */
export const CS_HISTORY_TYPE = {
  SIMPLE_INQUIRY: '단순문의',
  RESEND: '재전송',
  RECEIVER_CHANGE: '수신정보 변경요청',
  DISCARD: '폐기',
  REFUND_DISCARD: '환불폐기',
  DISCARD_REISSUE: '폐기 후 신규 발송',
} as const;

/**
 * CS 이력(order_history) 유형 단일 소스 — customer.service.service.ts 의 execHistory switch 가
 * 처리하는 유효 type 전체. 미지정 값은 execHistory default 에서 throw 되므로, 본 @IsIn 으로
 * 검증 진입 시점에 동일하게 차단한다(M-3, enum 미강제 매직스트링 하드닝).
 * ⚠️ PII_BEARING_HISTORY_TYPES(order 모듈, 부분집합)와 문자열이 정확히 일치해야 한다.
 */
export const CS_HISTORY_TYPES = [
  CS_HISTORY_TYPE.SIMPLE_INQUIRY,
  CS_HISTORY_TYPE.RESEND,
  CS_HISTORY_TYPE.RECEIVER_CHANGE,
  CS_HISTORY_TYPE.DISCARD,
  CS_HISTORY_TYPE.REFUND_DISCARD,
  CS_HISTORY_TYPE.DISCARD_REISSUE,
] as const;

export class CustomerServiceHistoryReqDto {
  @ApiProperty({ description: 'order_delivery_id' })
  // =============================================================
  @IsNotEmpty()
  @IsNumber()
  orderDeliveryId: number;

  @ApiProperty({
    description: '변경내역 후',
  })
  // =================================
  @IsOptional()
  @IsString()
  afterChange?: string;

  @ApiProperty({
    description: '유형',
    enum: CS_HISTORY_TYPES,
  })
  // =================================
  @IsOptional()
  @IsString()
  @IsIn([...CS_HISTORY_TYPES]) // 미정의 type 차단 (M-3). 누락 시엔 service validHistory 가 별도 안내
  type?: string;

  @ApiProperty({
    description: '내용',
  })
  // =================================
  @IsOptional()
  @IsString()
  content?: string;

  @ApiProperty({
    description: '재전송 type',
  })
  // =================================
  @IsOptional()
  @IsString()
  extraType?: string;
}

export class CustomerServiceStatusListReqDto extends PagingReqDto {
  @ApiProperty({ description: '발송 데이터 id' })
  // =============================================================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  orderDeliveryId: number;
}

export class CustomerServiceUnmaskedDeliveryTargetReqDto {
  @ApiProperty({ description: '발송 데이터 id' })
  // =============================================================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  orderDeliveryId: number;
}

export class CustomerServiceRefundReqDto {
  @ApiProperty({ description: '환불처리 하고자 하는 id' })
  // =============================================================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  orderDeliveryId: number;

  @ApiProperty({ description: '환불율 1~100 까지 입력 가능' })
  // =============================================================
  @IsNotEmpty()
  @IsNumber()
  @Max(100)
  @Min(1)
  @Type(() => Number)
  refundRatio: number;
}

export class CustomerServiceBulkDiscardReqDto {
  @ApiProperty({
    description: '폐기할 order_delivery ID 목록',
    type: [Number],
    example: [1, 2, 3],
  })
  // =============================================================
  @IsNotEmpty()
  @IsArray()
  @IsNumber({}, { each: true })
  orderDeliveryIds: number[];

  @ApiProperty({
    description: 'CS 내용 (1.의뢰자, 2.인입경로, 3.사유, 4.폐기여부, 5.비고)',
    example: '1. 의뢰자 : 홍길동\n2. 인입경로 : 전화\n3. 사유 : 고객 요청\n4. 폐기여부 : Y\n5. 비고 : 없음',
  })
  // =============================================================
  @IsNotEmpty()
  @IsString()
  content: string;
}

export class CustomerServiceExcelDownloadReqDto {
  @ApiProperty({
    description: '일반 쿠폰주문 CS: GENERAL, 신세계 :SSG',
  })
  // =============================================================
  @IsNotEmpty()
  @IsIn(['GENERAL', 'SSG'])
  orderType: IOrderType;

  @ApiPropertyOptional({
    description: '선택한 order_delivery ID 목록 (선택 다운로드 시 사용)',
    type: [Number],
    example: [1, 2, 3],
  })
  // =============================================================
  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  orderDeliveryIds?: number[];

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
    description: '고객사 ID (user_company.id)',
  })
  // =============================================================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  userCompanyId?: number;

  @ApiPropertyOptional({
    description: '핀 상태',
    enum: OrderDeliveryCouponStatus,
  })
  // =============================================================
  @IsOptional()
  @IsEnum(OrderDeliveryCouponStatus)
  couponStatus?: OrderDeliveryCouponStatus;

  @ApiPropertyOptional({
    description: '주문 번호 (부분검색)',
  })
  // =============================================================
  @IsOptional()
  @IsString()
  orderNumber?: string;

  @ApiPropertyOptional({
    description: '상품 코드 (부분검색)',
  })
  // =============================================================
  @IsOptional()
  @IsString()
  productCode?: string;

  @ApiPropertyOptional({
    description: '상품 명 (부분검색)',
  })
  // =============================================================
  @IsOptional()
  @IsString()
  productName?: string;

  @ApiPropertyOptional({
    description: '수신정보 - 전화번호 또는 이메일 (전문검색, 부분검색 불가)',
  })
  // =============================================================
  @IsOptional()
  @IsString()
  deliveryTarget?: string;

  @ApiPropertyOptional({
    description: 'MMS 제목 (부분검색)',
  })
  // =============================================================
  @IsOptional()
  @IsString()
  sendTitle?: string;

  @ApiPropertyOptional({
    description: '협력사 ID',
  })
  // =============================================================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  partnerCompanyId?: number;

  @ApiPropertyOptional({
    description: '핀번호 검색 (barCode, personalCode OR 조건 부분검색)',
  })
  // =============================================================
  @IsOptional()
  @IsString()
  barCode?: string;

  @ApiPropertyOptional({
    description: '통합검색 키워드 (주문번호, 상품명, 상품코드, MMS제목, 수신정보, 이벤트명을 OR 조건으로 검색)',
  })
  // =============================================================
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional({
    description: '이벤트명 (부분검색)',
  })
  // =============================================================
  @IsOptional()
  @IsString()
  eventName?: string;

  // expireDayMin/Max 는 사용자가 직접 입력하는 값이 아니라 프론트의 유효기간 프리셋
  // (30일=29/31, 60일=59/61, 5년=1824/1826 등) 상수로 전송된다 (product.req.dto.ts 와 동일 컨벤션)
  @ApiPropertyOptional({
    description: '유효기간(일) 하한 — 이 값 이상의 유효기간 상품 발송 건만 조회',
  })
  // =============================================================
  @IsOptional()
  @IsInt({ message: '유효기간 최소값은 정수로 입력해주세요.' })
  @Min(0, { message: '유효기간 최소값은 0일 이상으로 입력해주세요.' })
  @Type(() => Number)
  expireDayMin?: number;

  @ApiPropertyOptional({
    description: '유효기간(일) 상한 — 이 값 이하의 유효기간 상품 발송 건만 조회',
  })
  // =============================================================
  @IsOptional()
  @IsInt({ message: '유효기간 최대값은 정수로 입력해주세요.' })
  @Min(0, { message: '유효기간 최대값은 0일 이상으로 입력해주세요.' })
  @Type(() => Number)
  expireDayMax?: number;

  @ApiProperty({
    description: '비밀번호 (다운로드 확인용)',
  })
  // =============================================================
  @IsNotEmpty()
  @IsString()
  password: string;

  @ApiProperty({
    description: '다운로드 사유',
  })
  // =============================================================
  @IsNotEmpty()
  @IsString()
  downloadReason: string;
}
