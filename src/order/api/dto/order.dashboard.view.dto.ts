import { ApiProperty } from '@nestjs/swagger';

export class OrderDashboardViewDto {
  @ApiProperty({ description: '임시저장 일반쿠폰주문 건수' })
  tempGeneralCount: number;

  @ApiProperty({ description: '임시저장 신세계주문 건수' })
  tempSsgCount: number;

  @ApiProperty({ description: '임시저장 합계' })
  tempTotalCount: number;

  @ApiProperty({ description: '주문완료(발송요청) 일반쿠폰주문 건수' })
  deliveryRequestGeneralCount: number;

  @ApiProperty({ description: '주문완료(발송요청) 신세계주문 건수' })
  deliveryRequestSsgCount: number;

  @ApiProperty({ description: '주문완료(발송요청) 합계' })
  deliveryRequestTotalCount: number;

  @ApiProperty({ description: '발송대기(발송확정) 일반쿠폰주문 건수' })
  deliveryConfirmedGeneralCount: number;

  @ApiProperty({ description: '발송대기(발송확정) 신세계주문 건수' })
  deliveryConfirmedSsgCount: number;

  @ApiProperty({ description: '발송대기(발송확정) 합계' })
  deliveryConfirmedTotalCount: number;

  @ApiProperty({ description: '발송완료 일반쿠폰주문 건수' })
  deliveryCompleteGeneralCount: number;

  @ApiProperty({ description: '발송완료 신세계주문 건수' })
  deliveryCompleteSsgCount: number;

  @ApiProperty({ description: '발송완료 합계' })
  deliveryCompleteTotalCount: number;
}
