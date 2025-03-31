import { ApiProperty } from '@nestjs/swagger';

export class QnaDashboardViewDto {
  @ApiProperty({
    description: '임시 저장 건수',
  })
  tempCount: number;

  @ApiProperty({
    description: '답변 대기 건수',
  })
  waitCount: number;

  @ApiProperty({
    description: '답변 완료 건수',
  })
  completeCount: number;

  @ApiProperty({
    description: '최종 마감 건수',
  })
  deadlineCount: number;
}
