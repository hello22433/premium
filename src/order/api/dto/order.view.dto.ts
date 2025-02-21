import { IOrderStatus } from '../../interface/order.status';
import { ApiProperty } from '@nestjs/swagger';

export class OrderViewDto {
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
  userBusinessName: string;

  @ApiProperty({
    description: '담당자 이름',
  })
  userPersonName: string;

  @ApiProperty({
    description: '이벤트 명',
  })
  eventName: string;

  @ApiProperty({
    description: '상품명, 권 종',
  })
  productName: string;

  @ApiProperty({
    description: '품목 수량 ',
  })
  totalProductCount: number;

  @ApiProperty({
    description: '발송 수량 = 총 발송 수량',
  })
  totalAmount: number;

  @ApiProperty({
    description: '진행 상태',
  })
  status: IOrderStatus;

  @ApiProperty({
    description: '발송 시간 ex) yyyy-MM-ddTHH:mm:ss',
  })
  sendRequestAt: string | null;

  @ApiProperty({
    nullable: true,
    description: '운영 담당자 user id',
  })
  operationUserId: number | null;

  @ApiProperty({
    nullable: true,
    description: '운영 담당자 user 명칭',
  })
  operationUserName: string | null;

  @ApiProperty({
    description: '발송 금액',
  })
  deliveryPrice: number;

  @ApiProperty({
    description: '정산 금액',
  })
  settlePrice: number;
}
