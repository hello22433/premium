import { ApiProperty } from '@nestjs/swagger';
import { OrderDeliveryRefundStatusEnum } from '../../../delivery/interface/order.delivery.refund.status.enum';

export class RefundListViewDto {
  @ApiProperty({
    description: 'order delivery id',
  })
  id: number;

  @ApiProperty({
    description: '환불 접수 일자',
  })
  refundRegisterAt: string;

  @ApiProperty({
    description: '고객사 명',
  })
  userBusinessName: string;

  @ApiProperty({
    description: '품목명',
  })
  productName: string;

  @ApiProperty({
    description: '발송금액',
  })
  deliveryPrice: number;

  @ApiProperty({
    description: '발송일자',
  })
  sendRequestAt: string;

  @ApiProperty({
    description: '개인번호',
  })
  personalCode: string;

  @ApiProperty({
    description: '휴대폰번호',
  })
  deliveryTarget: string;

  @ApiProperty({
    description: '환불비율',
  })
  refundRatio: number;

  @ApiProperty({
    description: '환불금액',
  })
  refundPrice: number;

  @ApiProperty({
    description: '예금주',
  })
  bankAccountOwner: string | null;

  @ApiProperty({
    description: '은행명',
  })
  bankName: string | null;

  @ApiProperty({
    description: '계좌번호',
  })
  bankAccount: string | null;

  @ApiProperty({
    description: '환불상태',
  })
  refundStatus: OrderDeliveryRefundStatusEnum;

  @ApiProperty({
    description: '환불 일자',
  })
  refundAt: string | null;
}
