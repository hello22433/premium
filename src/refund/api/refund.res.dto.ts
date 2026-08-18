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
    description:
      '검색조건에 매칭되는 전체 행의 환불금액 합계 (원). 행별 refundPrice 와 같은 주문시점 액면가 기준(할인·카드할증 반영 전)이며, 페이지와 무관하고 매칭 0건이면 0',
  })
  totalRefundPrice: number;
}
