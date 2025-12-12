import { ApiProperty } from '@nestjs/swagger';
import { IOrderType } from '../../../order/interface/order.type';
import { IOrderStatus } from '../../../order/interface/order.status';

export class SettleProductMultipleDetailDto {
  @ApiProperty({
    description: 'product id',
  })
  id: number;

  @ApiProperty({
    description: '상품 코드',
  })
  code: string;

  @ApiProperty({
    description: '브랜드 이름(교환처)',
  })
  brandName: string;

  @ApiProperty({
    description: '상품 이름',
  })
  name: string;

  @ApiProperty({
    description: '상품 가격(단가, 공급가)',
  })
  price: number;

  @ApiProperty({
    description: '수량',
  })
  amount: number;

  @ApiProperty({
    description: '이벤트명 (해당 상품이 속한 이벤트)',
  })
  eventName: string;
}

export class SettleUserDetailMultipleDto {
  @ApiProperty({
    description: '선택된 order id 목록',
  })
  orderIds: number[];

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
    description: '이벤트 명 (여러개일 경우 "첫번째 외" 형식)',
  })
  eventName: string;

  @ApiProperty({
    description: '주문 관리 타입 (첫번째 주문 기준)',
  })
  type: IOrderType;

  @ApiProperty({
    description: '발송 요청 시각 ex) yyyy-MM-ddTHH:mm:ss (가장 최근 기준)',
    nullable: true,
  })
  sendRequestAt: string | null;

  @ApiProperty({
    description: 'status (첫번째 주문 기준)',
  })
  status: IOrderStatus;

  @ApiProperty({
    description: '통합된 상품 정보 리스트 (동일 상품+동일 단가는 합산, 다른 단가는 분리)',
  })
  productList: SettleProductMultipleDetailDto[];
}
