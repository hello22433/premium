import { ApiProperty } from '@nestjs/swagger';
import { IProductType } from '../../interface/product.type';
import { IProductUseStatus } from '../../interface/product.status';

export class ProductViewDto {
  @ApiProperty({
    description: 'product id',
  })
  id: number;

  @ApiProperty({
    description: '등록일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  createdAt: string;

  @ApiProperty({
    description: '상품유형 = 상품 구분 ex) 일반: GENERAL, 초이스: CHOICE, 배송: DELIVERY, 자체: SELF',
  })
  type: IProductType;

  @ApiProperty({
    description: '상품 코드',
  })
  code: string;

  @ApiProperty({
    description: '협력사 코드',
  })
  partnerCompanyCode: string;

  @ApiProperty({
    description: '협력사 id',
  })
  partnerCompanyId: number;

  @ApiProperty({
    description: '협력사 명',
  })
  partnerCompanyName: string;

  @ApiProperty({
    description: '대분류',
  })
  classification: string | null;

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
  expireDay: number | null;

  @ApiProperty({
    description: '상품 군 A, B, C, D',
  })
  category: string | null;

  @ApiProperty({
    description: '상품 사용 상태',
  })
  useStatus: IProductUseStatus;

  @ApiProperty({
    description: '변경 존재 여부',
  })
  isChange: boolean;

  @ApiProperty({
    description: '이미지 경로',
  })
  imagePath: string;

  @ApiProperty({
    description: '찜여부',
  })
  isLike: boolean;
}
