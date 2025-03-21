import { ApiProperty } from '@nestjs/swagger';
import { IProductUseStatus } from '../../../product/interface/product.status';

export class ProductChoiceDetailDto {
  @ApiProperty({
    description: 'product id',
  })
  id: number;

  @ApiProperty({
    description: '초이스 코드',
  })
  code: string;

  @ApiProperty({
    description: '상품명',
  })
  name: string;

  @ApiProperty({
    description: '가격',
  })
  price: number;

  @ApiProperty({
    description: '대표 이미지 path',
  })
  // ================================
  imagePath: string;

  @ApiProperty({
    description: '상품 사용 상태 ex) 사용: USE 미사용: UNUSED 영구 미사용: PERMANENTLY_UNUSED',
  })
  // ================================
  useStatus: IProductUseStatus;
}
