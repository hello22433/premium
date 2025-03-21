import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { ApiProperty } from '@nestjs/swagger';

export class OrderReceiveAlimTalkResDto {
  @ApiProperty({
    description: '상위 이미지',
  })
  topImagePath: string;

  @ApiProperty({
    description: '중간 이미지',
  })
  midImagePath: string;

  @ApiProperty({
    description: '발신 번호',
  })
  fromPhoneNumber: string;

  @ApiProperty({
    description: '상품 이름',
  })
  productName: string;

  @ApiProperty({
    description: '상품 이미지',
  })
  productImagePath: string;

  @ApiProperty({
    description: '브랜드 이름',
  })
  brandName: string;

  @ApiProperty({
    description: '상품 바코드',
  })
  barCode: string;

  @ApiProperty({
    description: 'ex) 미사용 : NOT_USED, 사용 완료: USED',
  })
  couponStatus: OrderDeliveryCouponStatus;

  @ApiProperty({
    description: '수신 내용',
  })
  context: string;
}

export class OrderReceiveEmailResDto {
  @ApiProperty({
    description: '상품 이름',
  })
  productName: string;

  @ApiProperty({
    description: '상품 이미지',
  })
  productImagePath: string;

  @ApiProperty({
    description: 'key 전송 값 ',
  })
  sendEncryptKey: string;
}
