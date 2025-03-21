import { ApiProperty } from '@nestjs/swagger';

export class ProductSsgDto {
  @ApiProperty({
    description: '상품 id',
  })
  id: number;

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
  expireDay: number;

  @ApiProperty({
    description: '미리보기 이미지 path',
  })
  imagePath: string;
}
