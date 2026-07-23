import { ApiProperty } from '@nestjs/swagger';
import { IProductUseStatus } from '../../../product/interface/product.status';

// 초이스쿠폰 상세의 구성상품 항목.
//
// 구성상품 검색 결과(getProductList)가 쓰는 ProductChoiceProductViewDto 와 형태가 겹치지만
// 별도 타입으로 둔다. 그쪽은 등록 가능한 상품만 내려가 삭제된 상품이 나올 수 없고,
// 여기만 삭제된 구성상품을 표시해야 해서 필드의 null 허용 범위가 다르다.
//
// 삭제된 구성상품은 매핑만 남고 상품 행이 soft-delete 된 상태다.
// 어떤 상품이 빠졌는지 알아야 관리자가 교체할 수 있으므로 code/name 은 삭제 시점 값을 그대로 싣고,
// 브랜드/대분류처럼 조인이 비는 필드는 빈 값으로 내린다.
export class ProductChoiceDetailProductViewDto {
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
    description: '대분류. 삭제된 구성상품이면 빈 문자열',
  })
  classification: string;

  @ApiProperty({
    description: '브랜드 id. 삭제된 구성상품이면 0',
  })
  brandId: number;

  @ApiProperty({
    description: '브랜드 명. 삭제된 구성상품이면 빈 문자열',
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
    description: '상품 군 A, B, C, D. 삭제된 구성상품이면 빈 문자열',
  })
  category: string;

  @ApiProperty({
    nullable: true,
    description: '상품 사용 상태. 삭제된 구성상품이면 null',
  })
  useStatus: IProductUseStatus | null;

  @ApiProperty({
    description: '삭제된 구성상품 여부. true 면 교체해야 초이스쿠폰을 다시 저장할 수 있다',
  })
  isDeleted: boolean;
}
