import { IOrderStatus } from '../../order/interface/order.status';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IOrderType } from '../../order/interface/order.type';
import { IsEnum, IsIn, IsNotEmpty, IsNumber, IsOptional, Matches } from 'class-validator';
import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { dateAtRegexp } from '../../common/domain/date.regexp';
import { Type } from 'class-transformer';

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
    description: 'orderProduct Mapping id',
  })
  // =============================================================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  orderProductMappingId: number;
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
}
