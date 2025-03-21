import { ApiProperty } from '@nestjs/swagger';

export class OrderFromPhoneViewDto {
  @ApiProperty({
    description: 'from phone id',
  })
  id: number;

  @ApiProperty({
    description: '발신 휴대폰 번호',
  })
  from: string;
}
