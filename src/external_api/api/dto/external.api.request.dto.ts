import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNumber, IsOptional, MaxLength, IsEnum, IsNotEmpty } from 'class-validator';
import { IOrderSendMethod } from '../../../order/interface/order.send.method';

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

  @ApiProperty({ description: '금액' })
  @IsNumber()
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
