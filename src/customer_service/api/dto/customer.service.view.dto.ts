import { IOrderStatus } from '../../../order/interface/order.status';
import { ApiProperty } from '@nestjs/swagger';
import { OrderDeliveryCouponStatus } from '../../../delivery/interface/order.delivery.coupon.status';

export class CustomerServiceViewDto {
  @ApiProperty({
    description: '등록일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  registerAt: string;

  @ApiProperty({
    description: '발송 일자 및 시각 ex) yyyy-MM-ddTHH:mm:ss',
  })
  sendRequestAt: string;

  @ApiProperty({
    nullable: true,
    description: '실제 발송 시간 ex) yyyy-MM-ddTHH:mm:ss',
  })
  actualSendAt: string | null;

  @ApiProperty({
    nullable: true,
    description: '발송 방식 ex) IMMEDIATE: 즉시발송, RESERVE: 예약발송',
  })
  sendType: string | null;

  @ApiProperty({
    description: 'order Id',
  })
  id: number;

  @ApiProperty({
    description: 'order delivery Id (발송 데이터 ID)',
  })
  orderDeliveryId: number | null;

  @ApiProperty({
    description: 'order Product id Id',
  })
  orderProductMappingId: number;

  @ApiProperty({
    description: '이벤트 명',
  })
  eventName: string;

  @ApiProperty({
    description: 'MMS 제목 (발신 제목)',
  })
  sendTitle: string;

  @ApiProperty({
    description: '고객사',
  })
  businessName: string;

  @ApiProperty({
    description: '상품 코드',
  })
  productCode: string;

  @ApiProperty({
    description: '상품 이름',
  })
  productName: string;

  @ApiProperty({
    description: '발송 번호',
  })
  fromPhoneNumber: string | null;

  @ApiProperty({
    description: '발송 이메일',
  })
  fromEmail: string | null;

  @ApiProperty({
    description: '발송 상태',
  })
  status: IOrderStatus;

  @ApiProperty({
    description: '핀 상태',
    enum: OrderDeliveryCouponStatus,
  })
  couponStatus: OrderDeliveryCouponStatus;

  @ApiProperty({
    description: '수신 정보 (전화번호 또는 이메일)',
  })
  deliveryTarget: string | null;

  @ApiProperty({
    description: '거래 ID',
  })
  transactionId: string | null;

  @ApiProperty({
    description: '발송 유형 (ALIM_TALK, EMAIL, SMS 등)',
  })
  deliveryMethod: string | null;

  @ApiProperty({
    description: '핀번호',
  })
  barCode: string | null;
}
