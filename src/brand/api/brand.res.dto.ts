import { BrandDetailDto } from './dto/brand.detail.dto';
import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { BrandViewDto } from './dto/brand.view.dto';
import { ApiProperty } from '@nestjs/swagger';

export class BrandGetSearchListResDto extends GetListResDto {
  @ApiProperty({
    type: [BrandViewDto],
    description: '브랜드 리스트',
  })
  list: BrandViewDto[];
}

export class BrandGetSelectListResDto {
  @ApiProperty({
    type: [BrandViewDto],
    description: '브랜드 리스트',
  })
  list: BrandViewDto[];
}

export class BrandGetDetailResDto extends BrandDetailDto {}
