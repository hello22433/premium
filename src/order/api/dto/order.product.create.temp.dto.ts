import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsNumber, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class OrderProductCreateTempDto {
  @ApiPropertyOptional({
    description: 'order product mapping 의 id ',
  })
  // =================================
  @IsOptional()
  @IsNumber()
  id?: number;

  @ApiProperty({
    description: 'product.id',
  })
  // =================================
  @IsNotEmpty()
  @IsNumber()
  productId: number;

  @ApiProperty({
    description: '상품 수량',
  })
  // =================================
  @IsNotEmpty()
  @IsNumber()
  amount: number;

  @ApiProperty({
    description: '수신자 정보 list',
  })
  // ===================================
  @IsArray() // 배열임을 검증
  @Type(() => OrderDeliveryCreateDto)
  orderDeliveryList: OrderDeliveryCreateDto[];
}

export class OrderDeliveryCreateDto {
  @ApiProperty({
    description: '전송 주체 EMAIL 일 경우 email, SMS, ALIM_TALK 일 경우 핸드폰 번호',
  })
  // =================================
  @IsNotEmpty()
  deliveryTarget: string;

  @ApiPropertyOptional({
    description: '대치문자 1 문구',
  })
  // =================================
  @IsOptional()
  replaceCharacter1?: string;

  @ApiPropertyOptional({
    description: '대치문자 2 문구',
  })
  // =================================
  @IsOptional()
  replaceCharacter2?: string;

  @ApiPropertyOptional({
    description: '대치문자 3 문구',
  })
  // =================================
  @IsOptional()
  replaceCharacter3?: string;
}
