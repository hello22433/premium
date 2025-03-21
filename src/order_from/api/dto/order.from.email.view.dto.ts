import { ApiProperty } from '@nestjs/swagger';

export class OrderFromEmailViewDto {
  @ApiProperty({
    description: 'order from id',
  })
  id: number;

  @ApiProperty({
    description: '발신 이메일 정보',
  })
  from: string;
}
