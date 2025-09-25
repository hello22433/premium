import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsNotEmpty, IsNumber, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';
import { IOrderType } from '../../order/interface/order.type';

export class OrderEventGetListReqQueryDto extends PagingReqDto {
  @ApiProperty({
    description: '주문 타입 ex) 일반: GENERAL, 신세계: SSG, 맞춤형: CUSTOM',
    default: 'GENERAL',
  })
  // ==============================================
  @IsNotEmpty()
  @IsEnum(IOrderType)
  type: IOrderType = IOrderType.GENERAL;

  @ApiPropertyOptional({
    description: '상품명',
  })
  // =========================
  @IsOptional()
  productName?: string;

  @ApiPropertyOptional({
    description: '브랜드명',
  })
  // =========================
  @IsOptional()
  brandName?: string;

  @ApiPropertyOptional({
    description: '행사명 (SSG 타입용)',
  })
  // =========================
  @IsOptional()
  eventName?: string;

  @ApiPropertyOptional({
    description: '행사 시작일 (SSG 타입용)',
  })
  // =========================
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional({
    description: '행사 종료일 (SSG 타입용)',
  })
  // =========================
  @IsOptional()
  endDate?: string;

  @ApiProperty({
    description: '찜한 주문 이벤트 불러오기',
  })
  // =================================
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true')
  isLike?: boolean;
}

export class OrderEventSetLikeReqDto {
  @ApiProperty({
    description: '찜하고자 하는 주문 id',
  })
  // =================================
  @IsNotEmpty()
  @IsNumber()
  orderId: number;

  @ApiProperty({
    description: '찜한 주문 이벤트 불러오기',
  })
  // =================================
  @IsNotEmpty()
  @IsBoolean()
  isLike: boolean;
}
