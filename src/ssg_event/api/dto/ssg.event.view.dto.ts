import { ApiProperty } from '@nestjs/swagger';

export class SsgEventViewDto {
  @ApiProperty({
    description: '협력사 id',
  })
  id: number;

  @ApiProperty({
    description: '행사코드',
  })
  code: string;

  @ApiProperty({
    description: '행사 순번',
  })
  order: number;

  @ApiProperty({
    description: '행사 번호',
  })
  no: string;

  @ApiProperty({
    description: '행사명',
  })
  name: string;

  @ApiProperty({
    description: '행사 시작 일',
  })
  startAt: string;

  @ApiProperty({
    description: '행사 끝 일',
  })
  endAt: string;

  @ApiProperty({
    description: '행사 금액',
  })
  eventPrice: number;

  @ApiProperty({
    description: '행사 잔액',
  })
  eventBalance: number;

  @ApiProperty({
    description: '발생 대기 건수',
  })
  deliveryWaitCount: number;

  @ApiProperty({
    description: '발생 대기 금액',
  })
  deliveryWaitAmount: number;

  @ApiProperty({
    description: '발생 완료 건수',
  })
  deliveryCompleteCount: number;

  @ApiProperty({
    description: '발생 완료 금액',
  })
  deliveryCompleteAmount: number;
}
