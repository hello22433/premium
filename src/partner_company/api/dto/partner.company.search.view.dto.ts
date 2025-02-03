import { ApiProperty } from '@nestjs/swagger';

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

  //TODO 상태
  @ApiProperty({
    description: '상태 TODO 현재 정상만 return',
  })
  status: string;
}
