import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, Min } from 'class-validator';

export class OrderRealProductCreateDto {
  @ApiProperty({
    description: 'product id',
  })
  // =================================
  @Type(() => Number)
  @IsNotEmpty()
  @IsInt()
  @Min(1)
  productId: number;

  @ApiProperty({
    description: '수량',
  })
  // =================================
  @Type(() => Number)
  @IsNotEmpty()
  @IsInt()
  @Min(1)
  quantity: number;

  @ApiProperty({
    description: '공급가액 (단가)',
  })
  // =================================
  @Type(() => Number)
  @IsNotEmpty()
  @IsInt()
  @Min(1)
  price: number;
}
