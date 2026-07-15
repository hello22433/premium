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
    description:
      '상품 가격(할인/할증 적용 단가, 행 내 균일). 차등정산(SSG 중복할인) 매핑은 요율 적용 단가별로 행이 분리되므로 price*amount 가 항상 정확한 공급가액.',
  })
  price: number;

  @ApiProperty({
    description: '수량',
  })
  amount: number;
}
