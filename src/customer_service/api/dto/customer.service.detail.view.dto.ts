import { ApiProperty } from '@nestjs/swagger';
import { IOrderDeliveryStatus } from '../../../delivery/interface/order.delivery.status';
import { IOrderDeliveryMethod } from '../../../delivery/interface/order.delivery.method';
import { IOrderSendMethod } from '../../../order/interface/order.send.method';
import { OrderDeliveryCouponStatus } from '../../../delivery/interface/order.delivery.coupon.status';
import { OrderDeliveryEmailCouponStatus } from '../../../delivery/interface/order.delivery.email.coupon.status';

export class CustomerServiceDetailViewDto {
  @ApiProperty({
    description: 'order delivery Id',
  })
  id: number;

  @ApiProperty({
    description: '등록일 ex)yyyy-MM-ddTHH:mm:ss',
  })
  registerAt: string;

  @ApiProperty({
    description: '상품명',
  })
  productName: string;

  @ApiProperty({
    description: '수신정보 (번호 혹은 이메일)',
  })
  deliveryTarget: string;

  @ApiProperty({ description: '수신자별 운영자 메모 (고객 미노출)', nullable: true })
  memo: string | null;

  @ApiProperty({
    description: '핀번호',
  })
  barCode: string | null;

  @ApiProperty({
    description: '교환처',
  })
  brandName: string;

  @ApiProperty({
    description: '협력사',
  })
  partnerCompanyName: string;

  @ApiProperty({
    description: '이벤트 명',
  })
  eventName: string;

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
    description: '교환일자 ex)yyyy-MM-ddTHH:mm:ss',
  })
  tradeAt: string | null;

  @ApiProperty({
    description: '교환장소 (사용처)',
    nullable: true,
  })
  tradePlace: string | null;

  @ApiProperty({
    description: '발송 상태',
    enum: IOrderDeliveryStatus,
  })
  status: IOrderDeliveryStatus;

  @ApiProperty({
    description: '핀 상태',
    enum: OrderDeliveryCouponStatus,
  })
  couponStatus: OrderDeliveryCouponStatus;

  @ApiProperty({
    description: '발송에러코드',
  })
  apiErrorMessage: string | null;

  @ApiProperty({
    description: '발송 방법 ex) 이메일: EMAIL, 문자: MMS, 알림톡: ALIM_TALK',
    enum: IOrderDeliveryMethod,
  })
  method: IOrderSendMethod;

  @ApiProperty({
    description: '이메일 쿠폰 발급 상태 (SEND: 발급완료, PIN_ISSUED: 문자발송실패, FAIL: 핀발급실패)',
    enum: OrderDeliveryEmailCouponStatus,
    nullable: true,
  })
  emailCouponStatus: OrderDeliveryEmailCouponStatus | null;

  @ApiProperty({
    description: '이메일 쿠폰 수령 시 입력한 핸드폰 번호 (마스킹 처리됨)',
    nullable: true,
  })
  emailReceiverPhone: string | null;

  @ApiProperty({
    description: '폐기 후 신규 발송 - 원본 OrderDelivery ID',
    nullable: true,
  })
  replacedFromId: number | null;
}
