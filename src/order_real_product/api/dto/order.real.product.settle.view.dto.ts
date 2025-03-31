import { ApiProperty } from '@nestjs/swagger';

export class OrderRealProductSettleViewDto {
  @ApiProperty({
    description: 'order id',
  })
  id: number;

  @ApiProperty({
    description: '고객사 명',
  })
  userBusinessName: string | null;

  @ApiProperty({
    description: '상품 대분류',
  })
  classification: string | null;

  @ApiProperty({
    description: '브랜드명',
  })
  brandName: string;

  @ApiProperty({
    description: '담당자 이름',
  })
  userPersonName: string | null;

  @ApiProperty({
    description: '이벤트 명',
  })
  eventName: string;

  @ApiProperty({
    description: '상품명',
  })
  productName: string;

  @ApiProperty({
    description: '발송 건수',
  })
  totalProductCount: number;

  @ApiProperty({
    description: '원가',
  })
  originalPrice: number;

  @ApiProperty({
    description: '판매가',
  })
  salePrice: number;

  @ApiProperty({
    description: '공급금액(판매가 합계)',
  })
  saleTotalPrice: number;

  @ApiProperty({
    description: '부가세(공금금액의 10%)',
  })
  tax: number;

  @ApiProperty({
    description: '합계 금액',
  })
  totalAmount: number;

  @ApiProperty({
    description: '수익 액',
  })
  profitAmount: number;

  @ApiProperty({
    description: '수익률(%)',
  })
  profitPercent: number;
}
