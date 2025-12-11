import { IOrderStatus } from '../../../order/interface/order.status';
import { ApiProperty } from '@nestjs/swagger';

export class SettleUserListViewDto {
  @ApiProperty({
    description: '정산 order id',
  })
  id: number;

  @ApiProperty({
    description: '등록일자 ex)yyyy-MM-ddTHH:mm:ss',
  })
  registeredAt: string;

  @ApiProperty({
    description: '고객사 이름',
  })
  businessName: string;

  @ApiProperty({
    description: '담당자 이름',
  })
  personName: string;

  @ApiProperty({
    description: '이벤트 명',
  })
  eventName: string;

  @ApiProperty({
    description: '상품 이름 list',
  })
  productNameList: string[];

  @ApiProperty({
    description: '발송 수량 ',
  })
  amount: number;

  @ApiProperty({
    description: '발송 금액',
  })
  deliveryPrice: number;

  @ApiProperty({
    description: '기존 정산금액',
  })
  originalSettlePrice: number;

  @ApiProperty({
    description: '할인옵션 적용 정산금액',
  })
  settlePrice: number;

  @ApiProperty({
    description: '진행 상태 ex) DELIVERY_CONFIRMED: 발송 대기, DELIVERY_COMPLETE: 발송 완료',
  })
  status: IOrderStatus;

  @ApiProperty({
    description: '발송 시각 ex)yyyy-MM-ddTHH:mm:ss',
    nullable: true,
  })
  sendRequestAt: string | null;

  @ApiProperty({
    description: '발송 완료 리포트 상태 ex) - / 다운로드 완료 / 다운로드(재) / 발행 완료 / 발행(재)',
  })
  deliveryReportStatus: string;

  @ApiProperty({
    description: '거래명세서 상태 ex) - / 다운로드 완료 / 다운로드(재) / 발행 완료 / 발행(재)',
  })
  transactionStatementStatus: string;
}
