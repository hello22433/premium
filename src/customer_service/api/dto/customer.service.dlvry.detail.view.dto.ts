import { ApiProperty } from '@nestjs/swagger';
import { OrderDeliveryCouponStatus } from '../../../delivery/interface/order.delivery.coupon.status';
import { IOrderDeliveryStatus } from '../../../delivery/interface/order.delivery.status';
import { OrderDeliveryRefundStatusEnum } from 'src/delivery/interface/order.delivery.refund.status.enum';

export class CustomerServiceDlvryDetailViewDto {
  @ApiProperty({
    description: 'order delivery Id',
  })
  orderDeliveryId: number;

  @ApiProperty({
    description: '이벤트명',
  })
  eventName: string;

  @ApiProperty({
    description: '고객사',
  })
  businessName: string;

  @ApiProperty({
    description: '발송담당자',
  })
  personName: string;

  @ApiProperty({
    description: '발송문구',
  })
  sendContent: string;

  @ApiProperty({
    description: '수신정보 (번호 혹은 이메일)',
  })
  deliveryTarget: string;

  @ApiProperty({
    description: '환불 상태',
    enum: OrderDeliveryRefundStatusEnum,
  })
  refundStatus: OrderDeliveryRefundStatusEnum | null;

  @ApiProperty({
    description: '발송일자 ex)yyyy-MM-ddTHH:mm:ss',
  })
  sendRequestAt: string | null;

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
    description: '발송 방법',
  })
  method: string | null;

  @ApiProperty({
    description: '발신정보 (번호 혹은 이메일)',
  })
  fromPhoneNumber: string | null;

  @ApiProperty({
    description: '협력사',
  })
  partnerCompanyName: string;

  @ApiProperty({
    description: '상품명',
  })
  productName: string;

  @ApiProperty({
    description: '상품가격',
  })
  price: string;

  @ApiProperty({
    description: '교환처',
  })
  brandName: string;

  @ApiProperty({
    description: '상품코드',
  })
  code: string;

  @ApiProperty({
    description: '핀 상태',
    enum: OrderDeliveryCouponStatus,
  })
  couponStatus: OrderDeliveryCouponStatus;

  @ApiProperty({
    description: '발송 상태',
    enum: IOrderDeliveryStatus,
  })
  status: IOrderDeliveryStatus;

  @ApiProperty({
    description: '발송에러코드',
  })
  apiErrorMessage: string | null;

  @ApiProperty({
    description: '핀번호',
  })
  barCode: string | null;

  @ApiProperty({
    description: '교환일자 ex)yyyy-MM-ddTHH:mm:ss',
  })
  tradeAt: string | null;

  @ApiProperty({
    description: '추가핀정보',
  })
  extraPinNo: string | null;

  @ApiProperty({
    description: '유효일수',
  })
  expireDay: string;

  @ApiProperty({
    description: '주문번호 (transaction_id)',
    nullable: true,
  })
  transactionId: string | null;
}
