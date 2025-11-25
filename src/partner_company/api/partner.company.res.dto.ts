import { ApiProperty } from '@nestjs/swagger';
import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { PartnerCompanyViewDto } from './dto/partner.company.view.dto';
import { PartnerCompanySearchViewDto } from './dto/partner.company.search.view.dto';
import { PartnerCompanyDetailDto } from './dto/partner.company.detail.dto';
import { PartnerCompanyValidityViewDto } from './dto/partner.company.validity.view.dto';

export class PartnerCompanyGetSearchListResDto extends GetListResDto {
  @ApiProperty({
    type: [PartnerCompanySearchViewDto],
    description: '협력사 조회 list',
  })
  list: PartnerCompanySearchViewDto[];
}

export class PartnerCompanyGetSelectListResDto {
  @ApiProperty({
    type: [PartnerCompanySearchViewDto],
    description: '협력사 조회 list',
  })
  list: PartnerCompanySearchViewDto[];
}

export class PartnerCompanyGetListResDto extends GetListResDto {
  @ApiProperty({
    description: '협력사 관리 list ',
  })
  list: PartnerCompanyViewDto[];
}

export class PartnerCompanyGetDetailResDto extends PartnerCompanyDetailDto {}

export class PartnerCompanyGetValidityListResDto {
  @ApiProperty({
    type: [PartnerCompanyValidityViewDto],
    description: '협력사 유효기간 설정 list',
  })
  list: PartnerCompanyValidityViewDto[];
}
