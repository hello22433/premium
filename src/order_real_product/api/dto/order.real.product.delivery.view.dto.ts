import { ApiProperty } from '@nestjs/swagger';
import { DeliveryTrackingStatus } from '../../../delivery/domain/delivery.tracking.status';

export class OrderRealProductDeliveryViewDto {
  @ApiProperty({
    description: 'order id',
  })
  id: number;

  @ApiProperty({
    description: '등록 날짜 ex) yyyy-MM-ddTHH:mm:ss',
  })
  registerAt: string;

  @ApiProperty({
    description: '고객사 이름',
  })
  userBusinessName: string | null;

  @ApiProperty({
    description: '담당자 이름',
  })
  userPersonName: string | null;

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
    description: `배송 상태 코드 ex) <br>
    - UNKNOWN: 현재 추적 상태를 알 수 없거나 확인할 수 없음 <br>
    - INFORMATION_RECEIVED: 추적 정보를 수신하여 처리 중 <br>
    - AT_PICKUP: 픽업 장소에 도착 <br>
    - IN_TRANSIT: 운송 중 <br>
    - OUT_FOR_DELIVERY: 배달 중 <br>
    - ATTEMPT_FAIL: 배달 시도 실패 <br>
    - DELIVERED: 배송 완료 <br>
    - AVAILABLE_FOR_PICKUP: 픽업 가능 상태 <br>
    - EXCEPTION: 배송 예외 상황`,
  })
  code: DeliveryTrackingStatus;
}
