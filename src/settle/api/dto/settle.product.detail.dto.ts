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

  @ApiProperty({
    description:
      '공급가액(라인 정확 합계). 차등정산(SSG 중복할인) 시 price는 반올림된 평균값이라 price*amount로 재구성하면 반올림 오차가 날 수 있음 — 합계가 필요하면 이 필드를 사용할 것.',
  })
  supplyAmount: number;
}
