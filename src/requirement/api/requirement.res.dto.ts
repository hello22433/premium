import { RequirementViewDto } from './dto/requirement.view.dto';
import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { ApiProperty } from '@nestjs/swagger';
import { RequirementDetailDto } from './dto/requirement.detail.dto';

export class RequirementGetListResDto extends GetListResDto {
  @ApiProperty({
    description: '요구사항 리스트',
    type: [RequirementViewDto],
  })
  list: RequirementViewDto[];
}

export class RequirementGetDetailResDto extends RequirementDetailDto {}
