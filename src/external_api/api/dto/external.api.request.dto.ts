import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsString, IsOptional, IsEnum, IsNotEmpty, IsInt, Min, Max } from 'class-validator';
import { IOrderSendMethod } from '../../../order/interface/order.send.method';
import { IsDivisibleBy5000 } from '../../../product/api/validator/is-divisible-by-5000.validator';

export class CreateExternalOrderDto {
  @ApiProperty({ description: '상품 코드' })
  @IsString()
  @IsNotEmpty()
  productCode: string;

  @ApiProperty({ description: '수신자 전화번호' })
  @IsString()
  @IsNotEmpty()
  recipientPhone: string;

  @ApiProperty({ description: '발신자 전화번호' })
  @IsString()
  @IsNotEmpty()
  senderPhone: string;

  @ApiPropertyOptional({ description: '메시지 제목' })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ description: '메시지 내용' })
  @IsString()
  @IsOptional()
  message?: string;

  @ApiProperty({ description: '발송 방법', enum: IOrderSendMethod })
  @IsEnum(IOrderSendMethod)
  deliveryMethod: IOrderSendMethod;
}

export class CreateExternalSsgOrderDto {
  @ApiProperty({ description: '수신자 전화번호' })
  @IsString()
  @IsNotEmpty()
  recipientPhone: string;

  @ApiProperty({ description: '금액 (5,000원 단위, 5,000원 이상 2,000,000원 이하)' })
  @IsInt()
  @Type(() => Number)
  @Min(5000, { message: '금액은 최소 5,000원 이상이어야 합니다.' })
  @Max(2000000, { message: '금액은 최대 2,000,000원 이하여야 합니다.' })
  @IsDivisibleBy5000({ message: '금액은 5,000원 단위로 입력해야 합니다.' })
  amount: number;

  @ApiPropertyOptional({ description: '발신자 전화번호' })
  @IsString()
  @IsOptional()
  senderPhone?: string;

  @ApiPropertyOptional({ description: '메시지 내용' })
  @IsString()
  @IsOptional()
  message?: string;
}

export class ExternalProductQueryDto {
  @ApiPropertyOptional({ description: '상품 코드 필터' })
  @IsString()
  @IsOptional()
  productCode?: string;
}
