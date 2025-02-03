import { IPartnerCompanySettleCondition } from '../../interface/partner.company.settle.condition';
import { IPartnerCompanySettleMethod } from '../../interface/partner.company.settle.method';
import { IPartnerCompanyStatus } from '../../interface/partner.company.status';
import { ApiProperty } from '@nestjs/swagger';

export class PartnerCompanyViewDto {
  @ApiProperty({
    description: '협력사 id',
  })
  id: number;

  @ApiProperty({
    description: '협력사 등록일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  createdAt: string;

  @ApiProperty({
    description: '협력사코드',
  })
  code: string;

  @ApiProperty({
    description: '협력사명',
  })
  businessName: string;

  @ApiProperty({
    description: '담당자명',
  })
  personName: string;

  @ApiProperty({
    description: '연락처',
  })
  personPhoneNumber: string;

  @ApiProperty({
    description: '이메일',
  })
  personEmail: string;

  @ApiProperty({
    type: String,
    description: '정산조건 ex) 선정산 : PRE_PAYMENT, 후정산 : POST_PAYMENT',
  })
  settleCondition: IPartnerCompanySettleCondition;

  @ApiProperty({
    // type: String,
    description: '정산방법 ex) 카드 : CARD 현금 : CASH',
  })
  settleMethod: IPartnerCompanySettleMethod;

  @ApiProperty({
    description: '정산 일',
  })
  settleDay: number;

  @ApiProperty({
    description: '여신한도',
  })
  maximumLimit: number;

  @ApiProperty({
    type: String,
    description: '상태 ex) 정상 : ACTIVE',
  })
  status: IPartnerCompanyStatus;
}
