import { ApiProperty } from '@nestjs/swagger';

export class UserSyncProductPersonInfoDto {
  @ApiProperty({
    description: '담당자 user.id',
  })
  userId: number;

  @ApiProperty({
    description: '담당자 이름',
  })
  personName: string;

  @ApiProperty({
    description: '담당자 이메일',
  })
  personEmail: string;

  @ApiProperty({
    description: '담당자 연락처',
  })
  personPhoneNumber: string;

  @ApiProperty({
    description: '기본 담당자 여부',
  })
  isHeadPerson: boolean;
}
