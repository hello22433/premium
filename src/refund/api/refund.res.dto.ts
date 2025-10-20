import { RefundListViewDto } from './dto/refund.list.view.dto';
import { ApiProperty } from '@nestjs/swagger';
import { GetListResDto } from '../../common/api/dto/get.list.res.dto';

export class RefundGetListResDto extends GetListResDto {
  @ApiProperty({
    type: [RefundListViewDto],
    description: '환불관리 리스트 ',
  })
  list: RefundListViewDto[];
}
