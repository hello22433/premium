import { ApiProperty } from '@nestjs/swagger';

export class OrderCustomerViewDto {
  @ApiProperty({
    description: 'user id',
  })
  id: number | null;

  @ApiProperty({
    description: '고객사 이름',
  })
  userBusinessName: string | null;

  @ApiProperty({
    description: '고객사 이메일',
  })
  userBusinessEmail: string | null;

  @ApiProperty({
    description: '고객사 연락처',
  })
  userPersonPhoneNumber: string | null;

  @ApiProperty({
    description: '고객사 담당자명',
  })
  userPersonName: string | null;
}
