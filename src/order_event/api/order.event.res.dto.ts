import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { OrderEventViewDto } from './dto/order.event.view.dto';
import { ApiProperty } from '@nestjs/swagger';

export class OrderEventResDto extends GetListResDto {
  @ApiProperty({
    description: '이벤트 불러오기 list ',
  })
  list: OrderEventViewDto[];
}
