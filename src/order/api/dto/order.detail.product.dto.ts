import { ApiProperty } from '@nestjs/swagger';
import { IOrderDeliveryMethod } from '../../../delivery/interface/order.delivery.method';
import { IOrderDeliveryStatus } from '../../../delivery/interface/order.delivery.status';
import { IOrderSendMethod } from '../../interface/order.send.method';
import { OrderEmailSendType } from '../../domain/order.email.send.type';

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
    description: '주문 수량',
  })
  amount: number;

  @ApiProperty({
    description: '유효 일',
  })
  expireDay: number;

  @ApiProperty({
    description: '상품 이미지 경로',
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

export class OrderDeliveryViewCommonDto {
  @ApiProperty({
    description: '주문 발송 id',
  })
  id: number;

  @ApiProperty({
    description: '발송시 수신 번호 전화번호 혹은 이메일',
  })
  deliveryTarget: string;
}

export class OrderViewDeliveryDto extends OrderDeliveryViewCommonDto {
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

  @ApiProperty({
    description: '발송 상태',
  })
  status: IOrderDeliveryStatus;

  @ApiProperty({
    description: '재발송 여부',
  })
  isResent: boolean;
}

export class OrderDeliveryCompleteReportViewDto extends OrderDeliveryViewCommonDto {
  @ApiProperty({
    description: '발송 요청 시각',
  })
  sendRequestAt: string | null;

  @ApiProperty({
    description: '실제 발송 시각',
  })
  actualSendAt: string | null;

  @ApiProperty({
    description: '상품명',
  })
  productName: string;

  @ApiProperty({
    description: '금액',
  })
  amount: number;

  @ApiProperty({
    description: '마스킹 된 바코드',
  })
  barCode: string | null;

  @ApiProperty({
    description: '배송 정보',
  })
  deliveryMethod: IOrderSendMethod;
}

export class OrderCompleteReportDeliveryViewDto {
  @ApiProperty({
    description: '발송 id',
  })
  id: number;

  @ApiProperty({
    description: '발송 시각',
  })
  sendRequestAt: string | null;

  @ApiProperty({
    description: '상품명',
  })
  productName: string;

  @ApiProperty({
    description: '수량',
  })
  quantity: number;

  @ApiProperty({
    description: '단가',
  })
  unitPrice: number;

  @ApiProperty({
    description: '공급가액',
  })
  price: number;
}

export class OrderDetailProductDto {
  @ApiProperty({
    description: 'order product mapping id',
  })
  id: number;

  @ApiProperty({
    description: '상품 정보',
  })
  product: OrderProductDto | null;

  @ApiProperty({
    type: [OrderViewDeliveryDto],
    description: '발송 상세 list',
  })
  orderDeliveryList: OrderViewDeliveryDto[];

  @ApiProperty({
    description: '주문 발송 방법',
  })
  sendMethod: IOrderSendMethod;

  @ApiProperty({
    description: '꼬리 광고 null 일시 무',
  })
  sendTailText: string | null;

  @ApiProperty({
    description: '개인정보 파기 요청 60, 180이 아닐시 기타로 표기',
  })
  requestToDestroyPersonalInfoDay: number | null;

  @ApiProperty({
    description: '발신 번호',
  })
  fromPhoneNumber: string | null;

  @ApiProperty({
    description: '발신 이메일',
  })
  fromEmail: string | null;

  @ApiProperty({
    description: '전송 제목',
  })
  sendTitle: string;

  @ApiProperty({
    description: 'QR, URL',
  })
  emailSendType: OrderEmailSendType | null;

  @ApiProperty({
    description: '이메일 사용 방법',
  })
  useEmailContent: string | null;

  @ApiProperty({
    description: '전송 내용',
  })
  sendContent: string;

  @ApiProperty({
    description: '발송 요청 시각 ex) yyyy-MM-ddTHH:mm:ss',
    nullable: true,
  })
  sendRequestAt: string | null;

  @ApiProperty({
    description: '발송 방식 ex) IMMEDIATE : 즉시, RESERVE : 예약',
  })
  sendType: string | null;

  @ApiProperty({
    description: '독려 문자 day (만료일 N일 전 발송, null이면 미사용)',
    nullable: true,
  })
  encourageDay: number | null;

  @ApiProperty({
    description: 'GALAXIA cpn 유효기간 일수 (null이면 미설정)',
    nullable: true,
  })
  galaxiaDuration: number | null;

  @ApiProperty({
    description: '해당 상품의 발송 실패 건수',
  })
  failCount: number;

  @ApiProperty({
    description: '주문 시점 가격과 현재 상품 가격이 다른지 여부 (legacy 스냅샷 없거나 삭제 상품이면 false)',
  })
  priceChanged: boolean;

  @ApiProperty({
    description: '주문 시점 스냅샷 가격 (legacy 주문은 null)',
    nullable: true,
  })
  snapshotPrice: number | null;

  @ApiProperty({
    description: '현재 상품 가격 (삭제된 상품이면 null)',
    nullable: true,
  })
  currentPrice: number | null;
}

export class OrderPdfDetailProductDto {
  @ApiProperty({
    description: 'order product mapping id',
  })
  id: number;

  @ApiProperty({
    description: '상품 정보',
  })
  product: OrderProductDto | null;

  @ApiProperty({
    type: [OrderDeliveryCompleteReportViewDto],
    description: '발송 상세 list',
  })
  orderDeliveryList: OrderDeliveryCompleteReportViewDto[];

  @ApiProperty({
    nullable: true,
    description: '발송 제목 (이벤트명)',
  })
  sendTitle: string | null;

  @ApiProperty({
    nullable: true,
    description: '발송 내용 (발송문구)',
  })
  sendContent: string | null;
}
