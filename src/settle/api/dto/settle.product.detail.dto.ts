import { ApiProperty } from '@nestjs/swagger';

export class SettleProductDetailDto {
  @ApiProperty({
    description: 'product id',
  })
  id: number;

  @ApiProperty({
    description: '상품 code',
  })
  code: string;

  @ApiProperty({
    description: '브랜드 이름(교환처)',
  })
  brandName: string;

  @ApiProperty({
    description: '상품 이름',
  })
  name: string;

  @ApiProperty({
    description: '상품 가격(단가, 공급가)',
  })
  price: number;

  @ApiProperty({
    description: '수량',
  })
  amount: number;
}
