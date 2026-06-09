import { IUserSettleCondition } from '../../../user/interface/user.settle.condition';
import { IUserSettleMethod } from '../../../user/interface/user.settle.method';
import { IUserStatus } from '../../../user/interface/user.status';
import { ApiProperty } from '@nestjs/swagger';

export class UserManagementViewDto {
  @ApiProperty({
    description: 'user id',
  })
  id: number;

  @ApiProperty({
    description: 'email',
  })
  email: string;

  @ApiProperty({
    description: '담당자 코드',
  })
  personCode: string;

  @ApiProperty({
    description: '고객사',
  })
  businessName: string;

  @ApiProperty({
    description: '담당자 이름',
  })
  personName: string;

  @ApiProperty({
    description: '담당자 연락처',
  })
  personPhoneNumber: string;

  @ApiProperty({
    description: '정산조건',
  })
  settleCondition: IUserSettleCondition;

  @ApiProperty({
    description: '정산 방법',
  })
  settleMethod: IUserSettleMethod;

  @ApiProperty({
    description: '최대 서비스 한도',
  })
  maximumLimit: number;

  @ApiProperty({
    description: '충전 잔액',
  })
  balance: number;

  @ApiProperty({
    description: '회원 상태',
  })
  status: IUserStatus;

  @ApiProperty({
    description: '로그인 영구 잠금 여부 (잠김 뱃지 표시용)',
  })
  isLoginLocked: boolean;

  @ApiProperty({
    description: '중복번호제어 (0: 중복허용, 1~10: 해당 개수만큼 중복 허용)',
  })
  duplicatePhoneLimit: number;
}
