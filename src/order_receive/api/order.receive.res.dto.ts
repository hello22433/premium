import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { ApiProperty } from '@nestjs/swagger';
import { IProductType } from '../../product/interface/product.type';
import { OrderReceiveChoiceDto } from './dto/order.receive.choice.dto';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';

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
    description: '상품 신세계 시 개인 번호',
  })
  personalCode: string | null;

  @ApiProperty({
    description: 'ex) 미사용 : NOT_USED, 사용 완료: USED',
  })
  couponStatus: OrderDeliveryCouponStatus;

  @ApiProperty({
    description: '수신 내용',
  })
  context: string;

  @ApiProperty({
    enum: IProductType,
    description: '일반 쿠폰: GENERAL, 초이스쿠폰: CHOICE',
  })
  type: IProductType;

  @ApiProperty({
    description: '초이스 쿠폰 일 시 선택 가능 리스트',
  })
  choiceProductList: OrderReceiveChoiceDto[];

  @ApiProperty({
    description: '초이스 쿠폰 일 시 선택한 초이스 쿠폰 정보',
  })
  selectChoiceProduct: OrderReceiveChoiceDto | null;

  @ApiProperty({
    description: '',
  })
  memo: string;

  @ApiProperty({
    description: '',
  })
  sendRequestAt: string;

  @ApiProperty({
    description: '',
  })
  expireDay: number;

  @ApiProperty({
    description: '',
  })
  brandKoreanName: string;

  @ApiProperty({
    description: '',
  })
  userBusinessName: string;

  @ApiProperty({
    enum: IPartnerCompanyType,
    description: '협력사 타입',
  })
  partnerCompany: IPartnerCompanyType | null;
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

  @ApiProperty({
    enum: IProductType,
    description: 'product type ex) 일반 : GENERAL, 초이스 : CHOICE',
  })
  type: IProductType;

  @ApiProperty({
    description: '초이스 쿠폰 일 시 선택 가능 리스트',
  })
  choiceProductList: OrderReceiveChoiceDto[];

  @ApiProperty({
    description: '초이스 쿠폰 일 시 선택한 초이스 쿠폰 정보',
  })
  selectChoiceProduct: OrderReceiveChoiceDto | null;
}
