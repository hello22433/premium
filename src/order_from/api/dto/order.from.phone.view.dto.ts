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

  @ApiProperty({
    description: '기본 발신번호 여부',
  })
  isDefault: boolean;
}
