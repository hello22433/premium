import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { ApiProperty } from '@nestjs/swagger';
import { OrderRealProductViewDto } from './dto/order.real.product.view.dto';
import { OrderRealProductSettleViewDto } from './dto/order.real.product.settle.view.dto';
import { OrderRealProductDetailDto } from './dto/order.real.product.detail.dto';
import { OrderCustomerViewDto } from '../../order/api/dto/order.customer.view.dto';
import { AdminListViewDto } from '../../settle/api/dto/admin.list.view.dto';
import { OrderRealProductDeliveryViewDto } from './dto/order.real.product.delivery.view.dto';
import { OrderRealProductDeliveryDetailDto } from './dto/order.real.product.delivery.detail.dto';

export class OrderRealProductGetListResDto extends GetListResDto {
  @ApiProperty({
    description: '실물 상품 주문 list',
  })
  list: OrderRealProductViewDto[];
}

export class OrderRealProductGetAdminListResDto extends GetListResDto {
  @ApiProperty({
    description: '담당자 list',
  })
  list: AdminListViewDto[];
}

export class OrderRealProductGetSettlementListResDto extends GetListResDto {
  @ApiProperty({
    description: '실물 상품 정산(수익률 조회) list',
  })
  list: OrderRealProductSettleViewDto[];
}

export class OrderRealProductGetDetailResDto extends OrderRealProductDetailDto {}

export class OrderRealProductGetDeliveryTrackingLastEventResDto {
  @ApiProperty({
    description: '실물 상품 배송 조회 list',
  })
  list: OrderRealProductDeliveryViewDto[];
}

export class OrderRealProductGetDeliveryTrackDetailResDto extends OrderRealProductDeliveryDetailDto {}

export class OrderRealProductGetDeliveryCompleteReportResDto extends OrderRealProductDetailDto {
  @ApiProperty({
    description: 'pdf 파운로드시 파일명',
  })
  fileName: string;

  @ApiProperty({
    description: '고객사 정보',
  })
  userInfo: OrderCustomerViewDto;
}
