import { OrderReceiptViewDto } from './dto/order.receipt.view.dto';
import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { ApiProperty } from '@nestjs/swagger';
import { OrderReceiptDetailDto } from './dto/order.receipt.detail.dto';

export class OrderReceiptGetListResDto extends GetListResDto {
  @ApiProperty({
    description: '주문접수 리스트',
  })
  list: OrderReceiptViewDto[];
}

export class OrderReceiptGetDetailResDto extends OrderReceiptDetailDto {}
