import { ApiProperty } from '@nestjs/swagger';
import { IUserSettleCondition } from '../../../user/interface/user.settle.condition';
import { OrderCompleteReportDeliveryViewDto } from './order.detail.product.dto';

export class OrderCompleteReportViewDto {
  @ApiProperty({
    description: '다운로드 될 pdf 파일 이름 ',
  })
  fileName: string;

  @ApiProperty({
    description: '거래명세서 일련번호',
  })
  serialNumber: string;

  @ApiProperty({
    description: '고객사 사업자등록번호',
  })
  businessNumber: string;

  @ApiProperty({
    description: '고객사 업체명',
  })
  businessName: string;

  @ApiProperty({
    description: '고객사 업체명',
  })
  personName: string;

  @ApiProperty({
    description: '사업장 주소 ',
  })
  businessAddress: string | null;

  @ApiProperty({
    description: '고객사 업태',
  })
  businessType: string | null;

  @ApiProperty({
    description: '고객사 종목',
  })
  businessItem: string | null;

  @ApiProperty({
    description: '이벤트 명',
  })
  eventName: string;

  @ApiProperty({
    description: '정산 조건 ex) 선정산 : PRE_PAYMENT, 후정산: POST_PAYMENT',
  })
  userSettleCondition: IUserSettleCondition;

  @ApiProperty({
    description: '거래일자(발송일자)',
  })
  sendRequestAt: string | null;

  @ApiProperty({
    description: '상품 공급가액(원가)',
  })
  price: number;

  @ApiProperty({
    description: '부가세 (공급가액의 10%)',
  })
  vat: number;

  @ApiProperty({
    description: '합계 금액 (공급가액 + 부가세)',
  })
  totalAmount: number;

  @ApiProperty({
    type: [OrderCompleteReportDeliveryViewDto],
    description: '발송 상세 list',
  })
  orderDeliveryList: OrderCompleteReportDeliveryViewDto[];
}
