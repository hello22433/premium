import { OrderViewDto } from './dto/order.view.dto';
import { ApiProperty } from '@nestjs/swagger';
import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { IOrderType } from '../interface/order.type';
import { IOrderSendMethod } from '../interface/order.send.method';
import { OrderDetailProductDto } from './dto/order.detail.product.dto';
import { IOrderStatus } from '../interface/order.status';

export class OrderGetListResDto extends GetListResDto {
  @ApiProperty({
    description: '주문 list',
  })
  list: OrderViewDto[];
}

export class OrderCreateTempResDto {
  @ApiProperty({
    description: '생성된 order id',
  })
  id: number;
}

export class OrderGetDetailResDto {
  @ApiProperty({
    description: 'order id',
  })
  id: number;

  @ApiProperty({
    description: '등록일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  registerAt: string;

  @ApiProperty({
    description: '이벤트 명',
  })
  eventName: string;

  @ApiProperty({
    description: '주문 관리 타입',
  })
  type: IOrderType;

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
  requestToDestroyPersonalInfoDay: number;

  @ApiProperty({
    description: '발신 번호',
  })
  fromPhoneNumber: string;

  @ApiProperty({
    description: '전송 제목',
  })
  sendTitle: string;

  @ApiProperty({
    description: '전송 내용',
  })
  sendContent: string;

  @ApiProperty({
    description: '발송 요청 시각 ex) yyyy-MM-ddTHH:mm:ss',
  })
  sendRequestAt: string;

  @ApiProperty({
    enum: IOrderStatus,
    description: 'status',
  })
  status: IOrderStatus;

  @ApiProperty({
    description: '상품 정보 리스트',
  })
  productList: OrderDetailProductDto[];
}
