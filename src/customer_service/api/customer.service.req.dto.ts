import { IOrderStatus } from '../../order/interface/order.status';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IOrderType } from '../../order/interface/order.type';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';
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
    description: 'user id',
  })
  // =============================================================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  userId?: number;

  @ApiPropertyOptional({
    description: '발송 상태',
  })
  // =============================================================
  @IsOptional()
  @IsEnum(IOrderStatus)
  status?: IOrderStatus;

  @ApiPropertyOptional({
    description: '주문 번호',
  })
  // =============================================================
  @IsOptional()
  orderNumber?: string;

  @ApiPropertyOptional({
    description: '이벤트 명',
  })
  // =============================================================
  @IsOptional()
  eventName?: string;

  @ApiPropertyOptional({
    description: '상품 코드',
  })
  // =============================================================
  @IsOptional()
  productCode?: string;

  @ApiPropertyOptional({
    description: '상품 명',
  })
  // =============================================================
  @IsOptional()
  productName?: string;
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

export class CustomerServiceStatusReqDto {
  @ApiProperty({ description: '핀상태변경 API' })
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