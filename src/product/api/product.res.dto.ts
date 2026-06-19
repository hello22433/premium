import { ProductViewDto } from './dto/product.view.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

export class ProductGetLinkAverageExpireDayResDto {
  @ApiPropertyOptional({
    description: '연동상품 유효기간 평균 (일). 연동상품 없으면 null',
    nullable: true,
  })
  averageExpireDay: number | null;
}

export class ProductSharedListFileResDto {
  @ApiPropertyOptional({
    description: '업로드 파일 id',
    nullable: true,
  })
  id: number | null;

  @ApiPropertyOptional({
    description: '업로드 파일명',
    nullable: true,
  })
  fileName: string | null;

  @ApiPropertyOptional({
    description: '업로드한 관리자 id',
    nullable: true,
  })
  userId: number | null;

  @ApiPropertyOptional({
    description: '업로드 일시',
    nullable: true,
  })
  createdAt: string | null;
}
