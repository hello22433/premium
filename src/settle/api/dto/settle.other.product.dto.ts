import { ApiProperty } from '@nestjs/swagger';

export class SettleOtherProductDetailDto {
  @ApiProperty({
    description: 'id',
  })
  id: number;

  @ApiProperty({
    description: '품목 코드',
  })
  code: string;

  @ApiProperty({
    description: '브랜드 명',
  })
  brandName: string;

  @ApiProperty({
    description: '품목명',
  })
  productName: string;

  @ApiProperty({
    description: '수량',
  })
  quantity: number;

  @ApiProperty({
    description: '단가',
  })
  price: number;

  @ApiProperty({
    description: '공급가(수량 x 단가)',
  })
  totalPrice: number;
}
