import { SettleUserOrderDetailEnum } from '../../interface/settle.user.order.detail';
import { ApiProperty } from '@nestjs/swagger';

export class SettleUserPerDetailViewDto {
  @ApiProperty({
    description: 'order id',
  })
  id: number;

  @ApiProperty({
    description: '고객사 명',
  })
  userBusinessName: string;

  @ApiProperty({
    description: '담당자명',
  })
  userPersonName: string;

  @ApiProperty({
    description: '발송일자',
    nullable: true,
  })
  sendRequestAt: string | null;

  @ApiProperty({
    description: '이벤트 명',
  })
  eventName: string;

  @ApiProperty({
    description: '상품명',
  })
  productName: string;

  @ApiProperty({
    description: '정산금액(정가)',
  })
  settleAmount: number;

  @ApiProperty({
    description: '정산금액(할인가)',
  })
  settleDiscountAmount: number;

  @ApiProperty({
    description: '증빙발행상태 ex) true: 증빙발행 false: 미발행',
  })
  isOrderCompleteReport: boolean;

  @ApiProperty({
    description: '증빙발행상태',
  })
  settleStatus: SettleUserOrderDetailEnum | null;

  @ApiProperty({
    description: '확정 여부',
  })
  isSettleComplete: boolean;
}
