import { ApiProperty } from '@nestjs/swagger';
import { IUserStatus } from '../../../user/interface/user.status';

export class AdminListViewDto {
  @ApiProperty({
    description: 'user id',
  })
  id: number;

  @ApiProperty({
    description: '담당자 이메일',
  })
  email: string;

  @ApiProperty({
    description: '담당자 회사명',
  })
  businessName: string;

  @ApiProperty({
    description: 'user 담당자 이름',
  })
  personName: string;

  @ApiProperty({
    description: '상태 ex) 사용 : USED, 미사용 : NOT_USED, 미승인 : NOT_APPROVED, 탈퇴 : LEAVE',
  })
  status: IUserStatus;
}
