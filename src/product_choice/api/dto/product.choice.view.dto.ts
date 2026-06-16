import { ApiProperty } from '@nestjs/swagger';
import { IProductUseStatus } from '../../../product/interface/product.status';

export class ProductChoiceViewDto {
  @ApiProperty({
    description: 'product id',
  })
  id: number;

  @ApiProperty({
    description: '등록일 ex) yyyy-MM-dd',
  })
  createdDate: string;

  @ApiProperty({
    description: '초이스 코드',
  })
  code: string;

  @ApiProperty({
    description: '상품명',
  })
  name: string;

  @ApiProperty({
    description: '단품 구성',
  })
  productComposition: string;

  @ApiProperty({
    description: '상품 수',
  })
  productCount: number;

  @ApiProperty({
    description: '사용 기간 ex) yyyy-MM-dd~yyyy-MM-dd',
  })
  usagePeriod: string;

  @ApiProperty({
    description: '상품 사용 상태',
  })
  useStatus: IProductUseStatus;

  @ApiProperty({
    description: '등록 상태 ex) 정상, 비정상',
  })
  registrationStatus: string;

  @ApiProperty({
    description: '묶인 구성상품 중 미사용/영구미사용 상품 존재 여부 (true: 비정상)',
  })
  hasUnusedProduct: boolean;
}
