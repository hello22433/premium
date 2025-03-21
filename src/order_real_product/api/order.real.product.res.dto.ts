import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { ApiProperty } from '@nestjs/swagger';
import { OrderRealProductViewDto } from './dto/order.real.product.view.dto';

export class OrderRealProductGetListResDto extends GetListResDto {
  @ApiProperty({
    description: '실물 상품 주문 list',
  })
  list: OrderRealProductViewDto[];
}
