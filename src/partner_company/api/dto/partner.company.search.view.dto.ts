import { ApiProperty } from '@nestjs/swagger';
import { IPartnerCompanyStatus } from '../../interface/partner.company.status';

export class PartnerCompanySearchViewDto {
  @ApiProperty({
    description: 'PartnerCompany.id',
  })
  id: number;

  @ApiProperty({
    description: '협력사 코드',
  })
  code: string;

  @ApiProperty({
    description: '협력사',
  })
  businessName: string;

  @ApiProperty({
    description: '담당자 이름',
  })
  personName: string;

  @ApiProperty({
    description: '상태',
  })
  status: IPartnerCompanyStatus;
}
