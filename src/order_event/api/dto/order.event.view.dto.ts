import { ApiProperty } from '@nestjs/swagger';

export class OrderEventViewDto {
  @ApiProperty({
    description: 'order id',
  })
  id: number;

  @ApiProperty({
    description: '등록 날짜 ex) yyyy-MM-ddTHH:mm:ss',
  })
  registerAt: string;

  @ApiProperty({
    description: '이벤트 코드',
  })
  code: string;

  @ApiProperty({
    description: '이벤트 명',
  })
  eventName: string;

  @ApiProperty({
    description: '상품 명',
  })
  productName: string;

  @ApiProperty({
    description: '상품 수',
  })
  productCount: number;

  @ApiProperty({
    description: '발송 수량',
  })
  deliveryCount: number;

  @ApiProperty({
    description: '발송 금액',
  })
  sendAmount: number;

  @ApiProperty({
    description: '찜 여부',
  })
  isLike: boolean;
}
