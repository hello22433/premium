import { ApiProperty } from '@nestjs/swagger';
import { IOrderType } from '../../../order/interface/order.type';
import { IOrderStatus } from '../../../order/interface/order.status';
import { SettleProductViewDto } from './settle.product.view.dto';

export class SettleUserDetailDto {
  @ApiProperty({
    description: 'order id',
  })
  id: number;

  @ApiProperty({
    description: '고객사 user id',
  })
  userId: number;

  @ApiProperty({
    description: '고객사 담당자',
  })
  userPersonName: string;

  @ApiProperty({
    description: '고객사 (회사명)',
  })
  userBusinessName: string;

  @ApiProperty({
    description: '운영 담당자 이름',
  })
  operationPersonName: string | null;

  @ApiProperty({
    description: '이벤트 명',
  })
  eventName: string;

  @ApiProperty({
    description: '주문 관리 타입',
  })
  type: IOrderType;

  @ApiProperty({
    description: '발송 요청 시각 ex) yyyy-MM-ddTHH:mm:ss',
    nullable: true,
  })
  sendRequestAt: string | null;

  @ApiProperty({
    enum: IOrderStatus,
    description: 'status',
  })
  status: IOrderStatus;

  @ApiProperty({
    description: '상품 정보 리스트',
  })
  productList: SettleProductViewDto[];
}
