import { ApiProperty } from '@nestjs/swagger';

export class OrderProductDto {
  @ApiProperty({
    description: 'product id',
  })
  id: number;

  @ApiProperty({
    description: '상품 이름',
  })
  name: string;

  @ApiProperty({
    description: '상품 가격',
  })
  price: number;

  @ApiProperty({
    description: '유효 일',
  })
  expireDay: number;

  @ApiProperty({
    description: '이미지 경로',
  })
  imagePath: string;

  @ApiProperty({
    description: '브랜드 id',
  })
  brandId: number;

  @ApiProperty({
    description: '브랜드 이름(교환처)',
  })
  brandName: string;
}

export class OrderViewDeliveryDto {
  @ApiProperty({
    description: '주문 발송 id',
  })
  id: number;

  @ApiProperty({
    description: '발송시 수신 번호 전화번호 혹은 이메일',
  })
  deliveryTarget: string;

  @ApiProperty({
    description: '대치문자 1',
  })
  replaceCharacter1: string | null;

  @ApiProperty({
    description: '대치문자 2',
  })
  replaceCharacter2: string | null;

  @ApiProperty({
    description: '대치문자 3',
  })
  replaceCharacter3: string | null;
}

export class OrderDetailProductDto {
  @ApiProperty({
    description: 'order product mapping id',
  })
  id: number;

  @ApiProperty({
    description: '상품 정보',
  })
  product: OrderProductDto;

  @ApiProperty({
    type: [OrderViewDeliveryDto],
    description: '발송 상세 list',
  })
  orderDeliveryList: OrderViewDeliveryDto[];
}
