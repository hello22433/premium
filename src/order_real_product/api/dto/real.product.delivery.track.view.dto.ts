import { ApiProperty } from '@nestjs/swagger';
import { DeliveryTrackingStatus } from '../../../delivery/domain/delivery.tracking.status';

export class DeliveryTrackLastEventStatusDto {
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
  code: string;

  @ApiProperty({
    description: '이벤트 발생 시간 ex) 2025-03-04T05:39:23.000+09:00',
  })
  time: string;
}

export class DeliveryTrackDetailEventDto {
  @ApiProperty({
    description: '이벤트 발생 시간 ex) 2025-03-04T05:39:23.000+09:00',
  })
  time: string;

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

  @ApiProperty({
    description: '배송 상태 명',
  })
  name: string;

  @ApiProperty({
    description: '배송 설명',
  })
  description: string;
}
