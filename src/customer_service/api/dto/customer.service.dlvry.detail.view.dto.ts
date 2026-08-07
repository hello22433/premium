import { ApiProperty } from '@nestjs/swagger';
import { OrderDeliveryCouponStatus } from '../../../delivery/interface/order.delivery.coupon.status';
import { IOrderDeliveryStatus } from '../../../delivery/interface/order.delivery.status';
import { OrderDeliveryRefundStatusEnum } from 'src/delivery/interface/order.delivery.refund.status.enum';
import { OrderDeliveryEmailCouponStatus } from '../../../delivery/interface/order.delivery.email.coupon.status';
import {
  InventoryPinCsAllowedAction,
  InventoryPinCsLatestAttemptStatus,
} from '../../../inventory_coupon/application/inventory.pin.cs.view.service';
import {
  DirectPinFulfillmentStatus,
  InventoryPinBillingChainState,
} from '../../../inventory_coupon/domain/inventory.pin.status';

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
    description: 'MMS 제목 (발송제목)',
    nullable: true,
  })
  sendTitle: string | null;

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
    description: '환불률 (1~100)',
    nullable: true,
  })
  refundRatio: number | null;

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
    description: '교환장소 (사용처)',
    nullable: true,
  })
  tradePlace: string | null;

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

  @ApiProperty({
    description: '유효기간 익일 시작 여부',
  })
  validityStartsNextDay: boolean;

  @ApiProperty({
    description: '유효기간 만료일 (YYYY-MM-DD)',
    nullable: true,
  })
  expireAt: string | null;

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

  @ApiProperty({
    description: '실제 쿠폰 발급 일시 (초이스 선택/이메일 전화번호 입력 시점) ex) yyyy-MM-ddTHH:mm:ss',
    nullable: true,
  })
  couponIssuedAt: string | null;

  // ── 해외 재고형 PIN 직접 이메일 (rev5 §4.1) ──
  // 재고형 발송건에서만 채워진다. 일반 쿠폰은 전 필드 undefined 이며,
  // 프론트는 deliveryContentMode 의 부재를 "일반 쿠폰"으로 처리한다.

  @ApiProperty({
    description: '재고형 PIN 직접 이메일 건이면 DIRECT_PIN, 일반 쿠폰이면 미포함',
    required: false,
  })
  deliveryContentMode?: 'DIRECT_PIN';

  @ApiProperty({ description: '교환처 코드 (재고형)', required: false })
  brandCode?: string;

  @ApiProperty({ description: '주 PIN 마스킹 표시값 (원문 아님)', required: false })
  primaryPinMasked?: string;

  @ApiProperty({ description: '보조 PIN 마스킹 표시값', required: false, nullable: true })
  secondaryPinMasked?: string | null;

  @ApiProperty({ description: 'PIN item 상태', required: false })
  pinInventoryStatus?: 'ASSIGNED' | 'VOID';

  @ApiProperty({ description: '직접 PIN fulfillment 상태', required: false })
  fulfillmentStatus?: DirectPinFulfillmentStatus;

  @ApiProperty({ description: '최신 이메일 발송 시도 상태', required: false })
  latestAttemptStatus?: InventoryPinCsLatestAttemptStatus;

  @ApiProperty({ description: '결제 체인 상태', required: false })
  paymentState?: InventoryPinBillingChainState;

  @ApiProperty({ description: '현재 환불·재발급 권한 소유 발송건 여부', required: false })
  isCurrentPaymentOwner?: boolean;

  @ApiProperty({ description: 'PIN 원문 확인 가능 여부', required: false })
  canRevealPin?: boolean;

  @ApiProperty({ description: '이전 소유 건의 PIN 원문 확인 가능 여부', required: false })
  canRevealHistoricalPin?: boolean;

  @ApiProperty({
    description: '서버가 판정한 허용 CS 액션 목록',
    required: false,
    isArray: true,
  })
  allowedActions?: InventoryPinCsAllowedAction[];
}
