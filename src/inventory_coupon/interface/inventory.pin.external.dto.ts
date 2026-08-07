import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreatePinInventoryOrderDto {
  @ApiProperty({ description: '상품 코드' })
  @IsNotEmpty()
  @IsString()
  productCode: string;

  @ApiProperty({ description: '수신자 이메일' })
  @IsNotEmpty()
  @IsEmail()
  recipientEmail: string;

  @ApiPropertyOptional({ description: '제목' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ description: '메시지' })
  @IsOptional()
  @IsString()
  message?: string;

  @ApiPropertyOptional({ description: '외부 고객 ID' })
  @IsOptional()
  @IsString()
  externalCustomerId?: string;

  @ApiProperty({ description: '외부 주문 번호 (필수)' })
  @IsNotEmpty()
  @IsString()
  externalOrderId: string;
}

/** PIN-free 응답 DTO. rev5 §11.4. */
export class PinInventoryOrderResponseDto {
  @ApiProperty()
  trId: string;

  @ApiProperty()
  externalOrderId: string;

  @ApiProperty({ enum: ['PENDING', 'SENT', 'FAILED', 'UNKNOWN', 'CANCELLED'] })
  status: 'PENDING' | 'SENT' | 'FAILED' | 'UNKNOWN' | 'CANCELLED';

  @ApiProperty()
  productCode: string;

  @ApiProperty({ description: '액면가 (문자열)' })
  faceValueAmount: string;

  @ApiProperty({ description: 'ISO 4217 통화코드' })
  currencyCode: string;

  @ApiPropertyOptional({ description: '유효종료일' })
  validEndDate?: string;
}
