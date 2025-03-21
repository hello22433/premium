import { ApiProperty } from '@nestjs/swagger';
import { IProductSettleMethod } from '../../interface/product.settle.method';
import { IProductType } from '../../interface/product.type';

export class ProductDetailDto {
  id: number;

  @ApiProperty({
    description: '등록일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  createdAt: string;

  @ApiProperty({
    description: '상품 코드',
  })
  code: string;

  @ApiProperty({
    description: '상품 코드',
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
  expireDay: number;

  @ApiProperty({
    description: '상품 군 A, B, C, D',
  })
  category: string | null;

  @ApiProperty({
    description: '정산 방법 ex) 교환당 : PER_EXCHANGE, 발행당: PER_ISSUANCE, 상품당: PER_PRODUCT',
  })
  settleMethod: IProductSettleMethod;

  @ApiProperty({
    description: '정산 조건 (퍼센트) , ex) 30 = 30%',
  })
  settlePercent: number;

  @ApiProperty({
    description: '미리보기 이미지 path',
  })
  imagePath: string;

  @ApiProperty({
    description: '상품유형 ex) 일반: GENERAL, 초이스: CHOICE, 배송: DELIVERY, 자체: SELF',
  })
  type: IProductType;

  @ApiProperty({
    description: '쿠폰 생성 방법',
  })
  couponMethod: string;

  @ApiProperty({
    description: '유의사항',
  })
  memo: string | null;
}
