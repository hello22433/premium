import { IOrderStatus } from '../interface/order.status';
import { IsArray, IsEnum, IsNotEmpty, IsNumber, IsOptional, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { dateAtRegexp } from '../../common/domain/date.regexp';
import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { OrderCreateDto } from './dto/order.create.dto';
import { IOrderType } from '../interface/order.type';
import { IOrderSection } from '../interface/order.section';
import { Type } from 'class-transformer';
import { OrderSettleCreateDto } from './dto/order.settle.create.dto';

export class OrderGetListReqDto extends PagingReqDto {
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
    description: '고객사 id (user id)',
  })
  // ===================================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  userId?: number;

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
    description: '발송 명 = 이벤트 명',
  })
  // ===================================
  @IsOptional()
  eventName?: string;
}

export class OrderCreateTempReqDto extends OrderCreateDto {
  @ApiProperty({
    description: '주문 타입 ex) 일반: GENERAL, 신세계: SSG',
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

export class OrderUpdateTempReqDto extends OrderCreateDto {
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

export class OrderDeliveryCancelReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ==================================
  @IsNotEmpty()
  @IsNumber()
  id: number;
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

export class OrderExcelDownloadReqQueryDto {
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
    description: '고객사 id (user id)',
  })
  // ===================================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  userId?: number;

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
    description: '발송 명 = 이벤트 명',
  })
  // ===================================
  @IsOptional()
  eventName?: string;
}
