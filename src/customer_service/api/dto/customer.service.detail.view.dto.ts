import { ApiProperty } from '@nestjs/swagger';
import { IOrderDeliveryStatus } from '../../../delivery/interface/order.delivery.status';
import { IOrderDeliveryMethod } from '../../../delivery/interface/order.delivery.method';
import { IOrderSendMethod } from '../../../order/interface/order.send.method';

export class CustomerServiceDetailViewDto {
  @ApiProperty({
    description: 'order delivery Id',
  })
  id: number;

  @ApiProperty({
    description: '이벤트 명',
  })
  eventName: string;

  @ApiProperty({
    description: '상품 이름',
  })
  productName: string;

  @ApiProperty({
    description: '등록일 ex)yyyy-MM-ddTHH:mm:ss',
  })
  registerAt: string;

  @ApiProperty({
    description: '수신 정보 (번호 혹은 이메일)',
  })
  deliveryTarget: string;

  @ApiProperty({
    description: '교환 시각',
  })
  tradeAt: string | null;

  @ApiProperty({
    description: '발송 상태',
    enum: IOrderDeliveryStatus,
  })
  status: IOrderDeliveryStatus;

  @ApiProperty({
    description: '발송 방법 ex) 이메일: EMAIL, 문자: SMS, 알림톡: ALIM_TALK',
    enum: IOrderDeliveryMethod,
  })
  method: IOrderSendMethod;

  @ApiProperty({ description: '교환처' })
  brandName: string;
}
