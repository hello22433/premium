import { ApiProperty } from '@nestjs/swagger';

export class CancelCouponResDto {
  @ApiProperty({
    description: 'response 코드',
  })
  code: string;

  @ApiProperty({
    description: 'response 메시지',
  })
  message: string;
}
