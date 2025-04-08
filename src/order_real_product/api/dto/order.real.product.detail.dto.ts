import { ApiProperty } from '@nestjs/swagger';
import { RealProductViewDto } from './real.product.view.dto';
import { PublicChargeTaxViewDto } from './public.charge.tax.view.dto';
import { IOrderRealProductStatus } from '../../interface/order.real.product.status';

export class OrderRealProductDetailDto {
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
    description: '(고객사) 담당자 이름',
  })
  userPersonName: string | null;

  @ApiProperty({
    description: '이벤트 명',
  })
  eventName: string;

  @ApiProperty({
    description:
      '주문 상태 <br>' +
      '  ORDER_PENDING : 확정 대기<br>' +
      '  ORDER_CONFIRM : 주문 확정 <br>' +
      '  STORAGE_COMPLETED : 입고 완료<br>' +
      '  DELIVERY_PROGRESS : 배송중<br>' +
      '  DELIVERY_COMPLETED : 배송 완료<br>' +
      '  ORDER_CANCELED : 주문 취소',
  })
  status: IOrderRealProductStatus;

  @ApiProperty({
    description: '주문 상품 내역 list',
  })
  orderRealProductList: RealProductViewDto[];

  @ApiProperty({
    description: '제세공과금 내역 list',
  })
  publicChargeTaxList: PublicChargeTaxViewDto[];
}
