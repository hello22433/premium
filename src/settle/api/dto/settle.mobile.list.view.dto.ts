import { ApiProperty } from '@nestjs/swagger';

export class SettleMobileListViewDto {
  @ApiProperty({
    description: '정산 order id',
  })
  id: number;

  @ApiProperty({
    description: '고객사 회사 이름',
  })
  businessName: string;

  @ApiProperty({
    description: '대분류',
  })
  productClassification: string;

  @ApiProperty({
    description: '브랜드 명 한글',
  })
  brandNameKorean: string;

  @ApiProperty({
    description: '브랜드 명 영문',
  })
  brandNameEnglish: string;

  @ApiProperty({
    description: '담당자 명',
  })
  personName: string;

  @ApiProperty({
    description: '이벤트 명',
  })
  eventName: string;

  @ApiProperty({
    description: '상품 명',
  })
  productName: string;

  @ApiProperty({
    description: '발송 건수',
  })
  deliveryAmount: number;

  @ApiProperty({
    description: '교환 건수',
  })
  tradeAmount: number;

  @ApiProperty({
    description: '폐기 건수',
  })
  discardAmount: number;

  @ApiProperty({
    description: '교환 율',
  })
  tradeRate: number;

  @ApiProperty({
    description: '환불 건수',
  })
  refundAmount: number;

  @ApiProperty({
    description: '발송 금액',
  })
  deliveryPrice: number;

  @ApiProperty({
    description: '미교환 금액',
  })
  unExchangedPrice: number;

  @ApiProperty({
    description: '환불 액',
  })
  refundPrice: number;

  @ApiProperty({
    description: '카드 수수료',
  })
  cardFee: number;

  @ApiProperty({
    description: '발송료',
  })
  deliveryFee: number;

  @ApiProperty({
    description: '수익액',
  })
  profitAmount: number;

  @ApiProperty({
    description: '수익율',
  })
  profitRate: number;
}
