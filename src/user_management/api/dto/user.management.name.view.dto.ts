import { ApiProperty } from '@nestjs/swagger';

export class UserManagementNameViewDto {
  @ApiProperty({
    description: 'user id',
  })
  id: number;

  @ApiProperty({
    description: 'user 고객사 담당자 이름',
  })
  personName: string;

  @ApiProperty({
    description: 'user 고객사 이름',
  })
  businessName: string;
}
