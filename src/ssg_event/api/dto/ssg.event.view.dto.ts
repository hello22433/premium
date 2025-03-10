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
}
