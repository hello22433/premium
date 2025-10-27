import { IUserSettleCondition } from '../../../user/interface/user.settle.condition';
import { UserSettlePeriodConditionEnum } from '../../../user/interface/user.settle.period.condition.enum';
import { SettleUserStatusEnum } from '../../interface/settle.user.status';
import { ApiProperty } from '@nestjs/swagger';

export class SettleUserPerListViewDto {
  @ApiProperty({
    description: 'user id',
  })
  id: number;

  @ApiProperty({
    description: 'user 이메일 (계정명, 아이디)',
  })
  email: string;

  @ApiProperty({
    description: '고객사 명',
  })
  businessName: string;

  @ApiProperty({
    description: '담당자 명',
  })
  personName: string;

  @ApiProperty({
    description: '정산 방법',
  })
  settleCondition: IUserSettleCondition;

  @ApiProperty({
    description: '정산 주기',
  })
  settlePeriodCondition: UserSettlePeriodConditionEnum | null;

  @ApiProperty({
    description: '정산일정',
  })
  settlePeriodCount: number | null;

  @ApiProperty({
    description: '최대 서비스 한도',
  })
  maximumLimit: number;

  @ApiProperty({
    description: '서비스 금액',
  })
  serviceAmount: number;

  @ApiProperty({
    description: '정산기일 초과 건수',
  })
  overdueCount: number;

  @ApiProperty({
    description: '정산 기일 초과 금액',
  })
  overdueAmount: number;

  @ApiProperty({
    description: '선입금 금액',
  })
  balance: number;

  @ApiProperty({
    description: '잔여 서비스 한도',
  })
  remainServiceAmount: number;

  @ApiProperty({
    description: '상태',
  })
  status: SettleUserStatusEnum;
}
