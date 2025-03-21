import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber } from 'class-validator';

export class OrderRealProductCreateDto {
  // @ApiPropertyOptional({
  //   description: 'order real product mapping 의 id ',
  // })
  // // =================================
  // @IsOptional()
  // @IsNumber()
  // id?: number;

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
}
