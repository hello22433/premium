import { ApiProperty } from '@nestjs/swagger';
import { IPartnerCompanySettleCondition } from '../../interface/partner.company.settle.condition';
import { IPartnerCompanySettleMethod } from '../../interface/partner.company.settle.method';
import { IPartnerCompanyStatus } from '../../interface/partner.company.status';

export class PartnerCompanyDetailDto {
  @ApiProperty({
    description: '협력사 id',
  })
  id: number;

  @ApiProperty({
    description: '협력사코드',
  })
  code: string;

  @ApiProperty({
    description: '법인 등록 번호',
  })
  corporateNumber: string | null;

  @ApiProperty({
    description: '사업자 등록 번호',
  })
  businessNumber: string;

  @ApiProperty({
    description: '협력사명(사업자명)',
  })
  businessName: string;

  @ApiProperty({
    description: '사업자 주소',
  })
  businessAddress: string;

  @ApiProperty({
    description: '사업자 연락처',
  })
  businessPhoneNumber: string;

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
    description: '정산조건 ex) 선정산 : PRE_PAYMENT, 후정산 : POST_PAYMENT',
  })
  settleCondition: IPartnerCompanySettleCondition;

  @ApiProperty({
    description: '정산 일',
  })
  settleDay: number;

  @ApiProperty({
    // type: String,
    description: '정산방법 ex) 카드 : CARD 현금 : CASH',
  })
  settleMethod: IPartnerCompanySettleMethod;

  @ApiProperty({
    description: '여신한도',
  })
  maximumLimit: number;

  @ApiProperty({
    description: '은행명',
  })
  bankName: string;

  @ApiProperty({
    description: '은행명',
  })
  bankNumber: string;

  @ApiProperty({
    type: String,
    description: '상태 ex) 정상 : ACTIVE',
  })
  status: IPartnerCompanyStatus;

  @ApiProperty({
    description: '협력사 등록일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  createdAt: string;

  @ApiProperty({
    description: '유효기간 시작일 설정 (true: 다음날부터, false: 당일 포함)',
  })
  validityStartsNextDay: boolean;
}
