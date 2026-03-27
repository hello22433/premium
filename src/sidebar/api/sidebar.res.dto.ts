import { ApiProperty } from '@nestjs/swagger';

export class SidebarNotificationsResDto {
  @ApiProperty({ description: '일반쿠폰주문 - 주문완료(DELIVERY_REQUEST) 상태 건수' })
  generalCouponCount: number;

  @ApiProperty({ description: '신세계주문 - 주문완료(DELIVERY_REQUEST) 상태 건수' })
  ssgCount: number;

  @ApiProperty({ description: '주문접수 - 접수(RECEIVED) 상태 건수' })
  orderReceiptCount: number;

  @ApiProperty({ description: '1:1문의 - 답변대기(WAIT) 상태 건수' })
  qnaWaitCount: number;
}
