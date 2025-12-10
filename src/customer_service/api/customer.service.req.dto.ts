import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IOrderType } from '../../order/interface/order.type';
import { IsArray, IsEnum, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { dateAtRegexp } from '../../common/domain/date.regexp';
import { Type } from 'class-transformer';
import { OrderDeliveryCouponStatus } from 'src/delivery/interface/order.delivery.coupon.status';

export class CustomerServiceGetListReqDto extends PagingReqDto {
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
    description: 'user id (고객사)',
  })
  // =============================================================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  userId?: number;

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
    description: '변경내역 후',
  })
  // =================================
  @IsOptional()
  @IsString()
  afterChange?: string;
}

export class CustomerServicePinStatusRefreshReqDto {
  @ApiProperty({ description: '핀상태갱신 API' })
  // =============================================================
  @IsNotEmpty()
  @IsNumber()
  orderDeliveryId: number;
}

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
  })
  // =================================
  @IsOptional()
  @IsString()
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
    description: 'user id (고객사)',
  })
  // =============================================================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  userId?: number;

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
