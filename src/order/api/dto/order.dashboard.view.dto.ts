import { ApiProperty } from '@nestjs/swagger';

export class OrderDashboardViewDto {
  @ApiProperty({
    description: '입금 대기 건수',
  })
  waitingDepositCount: number;

  @ApiProperty({
    description: '결제 완료 건수',
  })
  completeCount: number;

  @ApiProperty({
    description: '주문 미처리 건수',
  })
  notProcessCount: number;

  @ApiProperty({
    description: '입고 발주 건수',
  })
  stockOrderCount: number;
}
