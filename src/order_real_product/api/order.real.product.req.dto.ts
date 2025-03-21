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
import { Type } from 'class-transformer';
import { dateAtRegexp } from '../../common/domain/date.regexp';
import { IOrderRealProductStatus } from '../interface/order.real.product.status';
import { IPublicChargeTaxPaymentType } from '../interface/public.charge.tax.payment.type';
import { IProcessMethod } from '../interface/process.method';
import { OrderRealProductCreateDto } from './dto/order.real.product.create.dto';
import { IOrderSection } from '../../order/interface/order.section';

export class OrderRealProductGetListReqDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '구분 ex) 주문관리 : ORDER, 발송관리: SHIPPING',
    default: IOrderSection.ORDER,
  })
  // ==============================================
  @IsEnum(IOrderSection)
  section: IOrderSection = IOrderSection.ORDER;

  @ApiPropertyOptional({
    description:
      '발송 상태 <br>' +
      '  ORDER_PENDING : 확정 대기<br>' +
      '  ORDER_CONFIRM : 주문 확정 <br>' +
      '  STORAGE_COMPLETED : 입고 완료<br>' +
      '  DELIVERY_PROGRESS : 배송중<br>' +
      '  DELIVERY_COMPLETED : 배송 완료<br>' +
      '  ORDER_CANCELED : 주문 취소',
  })
  // ===================================
  @IsOptional()
  @IsEnum(IOrderRealProductStatus)
  status?: IOrderRealProductStatus;

  @ApiPropertyOptional({
    description: '고객사 id (user id)',
  })
  // ===================================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  userBusinessId?: number;

  @ApiPropertyOptional({
    description: '조회 시작 날짜 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // ===================================
  @IsOptional()
  @Matches(dateAtRegexp)
  startAt?: string;

  @ApiPropertyOptional({
    description: '조회 끝 날짜 ex) yyyy-MM-ddTHH:mm:ss',
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

export class OrderRealProductCreateReqDto {
  @ApiProperty({
    description: '고객사 user id',
  })
  // ===================================
  @IsNumber()
  userId: number;

  @ApiProperty({
    description: '실물 상품 주문',
  })
  // =================================
  @IsArray()
  @Type(() => OrderRealProductCreateDto)
  orderRealProductList: OrderRealProductCreateDto[];

  @ApiProperty({
    description: '이벤트 명',
  })
  // ===================================
  @IsString()
  eventName: string;

  @ApiProperty({
    description: '공급가액',
  })
  // ===================================
  @IsNumber()
  price: number;

  @ApiProperty({
    description: '기준가액 (제세공과금 계산의 기준가)',
  })
  // ===================================
  @IsNumber()
  standardAmount: number;

  @ApiProperty({
    description: '제세공과금 납부 방법 ex) PERSON: 고객납부, COMPANY: 고객사대납',
  })
  // ===================================
  @IsEnum(IPublicChargeTaxPaymentType)
  publicChargeTaxPayment: IPublicChargeTaxPaymentType;

  @ApiProperty({
    description: '처리 방식 ex) PRE: 사전처리, POST: 사후처리',
  })
  // ===================================
  @IsEnum(IProcessMethod)
  processMethod: IProcessMethod;

  @ApiProperty({
    description: '처리 여부 선택 ex) 처리: true, 미처리: false',
  })
  // ===================================
  @IsBoolean()
  isProcess: boolean;
}

export class OrderRealProductGetDetailReqParamDto {
  @ApiProperty({
    description: 'real product order id',
  })
  // ==================================
  @Type(() => Number)
  @Min(1)
  @IsInt()
  id: number;
}

export class OrderRealProductUpdateRequestReqDto {
  @ApiProperty({
    description: 'real product order id',
  })
  // ==================================
  @IsNotEmpty()
  @IsNumber()
  id: number;
}

export class OrderRealProductConfirmRequestReqDto {
  @ApiProperty({
    description: 'real product order id',
  })
  // ==================================
  @IsNotEmpty()
  @IsNumber()
  id: number;
}

export class OrderRealProductDeliveryTrackingReqDto {
  @ApiProperty({
    description: '택배사 id',
  })
  // ==================================
  @IsNotEmpty()
  @IsString()
  carrierId: string;

  @ApiProperty({
    description: '조회할 송장번호',
  })
  // ==================================
  @IsNotEmpty()
  @IsString()
  trackingNumber: string;
}

export class OrderRealProductTaxInfoUpdateReqDto {
  @ApiProperty({
    description: '변경할 mapping id',
  })
  // ==================================
  @IsArray()
  list: TaxInfoDto[];
}

export class TaxInfoDto {
  @ApiProperty({
    description: '변경할 mapping id',
  })
  // ==================================
  @Min(1)
  @Type(() => Number)
  @IsInt()
  mappingId: number;

  @ApiProperty({
    description: '제세공과금 납부 방법 ex) PERSON: 고객납부, COMPANY: 고객사대납',
  })
  // ===================================
  @IsEnum(IPublicChargeTaxPaymentType)
  publicChargeTaxPayment: IPublicChargeTaxPaymentType;

  @ApiProperty({
    description: '처리 방식 ex) PRE: 사전처리, POST: 사후처리',
  })
  // ===================================
  @IsEnum(IProcessMethod)
  processMethod: IProcessMethod;

  @ApiProperty({
    description: '처리 여부 선택 ex) 처리: true, 미처리: false',
  })
  // ===================================
  @IsBoolean()
  isProcess: boolean;
}

export class OrderRealProductExcelDownloadReqBodyDto {
  @ApiPropertyOptional({
    description: '구분 ex) 주문관리 : ORDER, 발송관리: SHIPPING',
    default: IOrderSection.ORDER,
  })
  // ==============================================
  @IsEnum(IOrderSection)
  section: IOrderSection = IOrderSection.ORDER;

  @ApiPropertyOptional({
    description:
      '발송 상태 <br>' +
      '  ORDER_PENDING : 확정 대기<br>' +
      '  ORDER_CONFIRM : 주문 확정 <br>' +
      '  STORAGE_COMPLETED : 입고 완료<br>' +
      '  DELIVERY_PROGRESS : 배송중<br>' +
      '  DELIVERY_COMPLETED : 배송 완료<br>' +
      '  ORDER_CANCELED : 주문 취소',
  })
  // ===================================
  @IsOptional()
  @IsEnum(IOrderRealProductStatus)
  status?: IOrderRealProductStatus;

  @ApiPropertyOptional({
    description: '고객사 id (user id)',
  })
  // ===================================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  userBusinessId?: number;

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
