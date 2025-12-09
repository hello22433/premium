import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber } from 'class-validator';

export class OrderRealProductCreateDto {
  @ApiProperty({
    description: 'product id',
  })
  // =================================
  @IsNotEmpty()
  @IsNumber()
  productId: number;

  @ApiProperty({
    description: '수량',
  })
  // =================================
  @IsNotEmpty()
  @IsNumber()
  quantity: number;

  @ApiProperty({
    description: '공급가액 (단가)',
  })
  // =================================
  @IsNotEmpty()
  @IsNumber()
  price: number;
}
