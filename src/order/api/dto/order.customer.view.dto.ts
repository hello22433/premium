import { ApiProperty } from '@nestjs/swagger';
import { CompanyType } from '../../../common/domain/company.type';

export class OrderCustomerViewDto {
  @ApiProperty({
    description: 'user id',
  })
  id: number | null;

  @ApiProperty({
    description: '고객사 이름',
  })
  userBusinessName: string | null;

  @ApiProperty({
    description: '고객사 이메일',
  })
  userBusinessEmail: string | null;

  @ApiProperty({
    description: '고객사 연락처',
  })
  userPersonPhoneNumber: string | null;

  @ApiProperty({
    description: '고객사 담당자명',
  })
  userPersonName: string | null;

  @ApiProperty({
    description: '기본 문서 양식',
    enum: CompanyType,
  })
  documentCompanyType: CompanyType;
}
