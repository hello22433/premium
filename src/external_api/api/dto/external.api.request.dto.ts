import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNumber, IsOptional, MaxLength, IsEnum, IsNotEmpty } from 'class-validator';
import { IOrderSendMethod } from '../../../order/interface/order.send.method';

export class CreateExternalOrderDto {
  @ApiProperty({ description: '외부 트랜잭션 ID (고유)', maxLength: 40 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  trId: string;

  @ApiProperty({ description: '상품 ID' })
  @IsNumber()
  productId: number;

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
  @ApiProperty({ description: '외부 트랜잭션 ID (고유)', maxLength: 40 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  trId: string;

  @ApiProperty({ description: 'SSG 이벤트 ID' })
  @IsNumber()
  ssgEventId: number;

  @ApiProperty({ description: '수신자 전화번호' })
  @IsString()
  @IsNotEmpty()
  recipientPhone: string;

  @ApiProperty({ description: '수신자 이름' })
  @IsString()
  @IsNotEmpty()
  recipientName: string;

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
  @ApiPropertyOptional({ description: '상품 ID 필터' })
  @IsNumber()
  @IsOptional()
  productId?: number;
}
