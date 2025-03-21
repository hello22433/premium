import { ApiProperty } from '@nestjs/swagger';
import { IProductUseStatus } from '../../../product/interface/product.status';

export class ProductChoiceProductViewDto {
  @ApiProperty({
    description: 'product id',
  })
  id: number;

  @ApiProperty({
    description: '등록일 ex) yyyy-MM-dd',
  })
  createdDate: string;

  @ApiProperty({
    description: '상품 코드',
  })
  code: string;

  @ApiProperty({
    description: '대분류',
  })
  classification: string;

  @ApiProperty({
    description: '브랜드 id',
  })
  brandId: number;

  @ApiProperty({
    description: '브랜드 명',
  })
  brandName: string;

  @ApiProperty({
    description: '상품 명',
  })
  name: string;

  @ApiProperty({
    description: '공급가액',
  })
  price: number;

  @ApiProperty({
    description: '유효 기간 (일)',
  })
  expireDay: number;

  @ApiProperty({
    description: '상품 군 A, B, C, D',
  })
  category: string;

  @ApiProperty({
    description: '상품 사용 상태',
  })
  useStatus: IProductUseStatus;
}
