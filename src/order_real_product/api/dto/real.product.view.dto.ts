import { ApiProperty } from '@nestjs/swagger';

export class RealProductViewDto {
  @ApiProperty({
    description: 'order real product mapping id',
  })
  mappingId: number;

  @ApiProperty({
    description: 'product id',
  })
  productId: number;

  @ApiProperty({
    description: '상품명',
  })
  productName: string;

  @ApiProperty({
    description: '상품 코드',
  })
  code: string;

  @ApiProperty({
    description: '색상',
  })
  color: string | null;

  @ApiProperty({
    description: '수량',
  })
  quantity: number;

  @ApiProperty({
    description: '공급가액',
  })
  price: number;

  @ApiProperty({
    description: '송장 번호',
  })
  trackingNumber: string | null;

  @ApiProperty({
    description: '부가세 (공급가액의 10%)',
  })
  vat: number;

  @ApiProperty({
    description: '합계 금액',
  })
  totalAmount: number;
}
