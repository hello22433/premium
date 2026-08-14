import { RefundListViewDto } from './dto/refund.list.view.dto';
import { ApiProperty } from '@nestjs/swagger';
import { GetListResDto } from '../../common/api/dto/get.list.res.dto';

export class RefundGetListResDto extends GetListResDto {
  @ApiProperty({
    type: [RefundListViewDto],
    description: '환불관리 리스트 ',
  })
  list: RefundListViewDto[];

  @ApiProperty({
    description: '검색조건에 매칭되는 전체 행의 환불금액 합계 (원). 페이지와 무관하며 매칭 0건이면 0',
  })
  totalRefundPrice: number;
}
