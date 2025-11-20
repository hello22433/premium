import { ProductViewDto } from './dto/product.view.dto';
import { ApiProperty } from '@nestjs/swagger';
import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { ProductDetailDto } from './dto/product.detail.dto';
import { ProductHistoryViewDto } from './dto/product.history.view.dto';
import { ProductSsgDto } from './dto/product.ssg.dto';
import { ClassificationViewDto } from './dto/classification.view.dto';

export class ProductGetListResDto extends GetListResDto {
  @ApiProperty({
    type: [ProductViewDto],
    description: '상품 list',
  })
  list: ProductViewDto[];
}

export class ProductGetSsgResDto extends ProductSsgDto {}

export class ProductGetDetailResDto extends ProductDetailDto {}

export class ProductGetUpdateHistoryResDto extends GetListResDto {
  @ApiProperty({
    type: [ProductHistoryViewDto],
    description: '변경 내역 히스토리 list ',
  })
  list: ProductHistoryViewDto[];
}

export class ClassificationGetSearchListResDto extends GetListResDto {
  @ApiProperty({
    type: [ClassificationViewDto],
    description: '대분류 리스트',
  })
  list: ClassificationViewDto[];
}
