import { ApiProperty } from '@nestjs/swagger';
import { DeliveryTrackDetailEventDto } from './real.product.delivery.track.view.dto';

export class OrderRealProductDeliveryDetailDto {
  @ApiProperty({
    description: 'order id',
  })
  id: number;

  @ApiProperty({
    description: '이벤트 명',
  })
  eventName: string;

  @ApiProperty({
    description: '상품명',
  })
  productName: string;

  @ApiProperty({
    description: '수령인 이름',
  })
  receiver: string | null;

  @ApiProperty({
    description: '고객사 수령주소',
  })
  businessAddress: string;

  @ApiProperty({
    description: '송장번호',
  })
  trackingNumber: string;

  @ApiProperty({
    description: '배송 정보 마지막 이벤트 상태',
  })
  lastEvent: string | null;

  @ApiProperty({
    description: '최근 배송 이벤트 목록 (최대 10개)',
  })
  events: DeliveryTrackDetailEventDto[] | null;
}
