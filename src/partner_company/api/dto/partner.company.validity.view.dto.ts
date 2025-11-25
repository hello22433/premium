import { ApiProperty } from '@nestjs/swagger';

export class PartnerCompanyValidityViewDto {
  @ApiProperty({
    description: '협력사명',
  })
  businessName: string;

  @ApiProperty({
    description: '유효기간 익일 시작 여부',
  })
  validityStartsNextDay: boolean;
}
