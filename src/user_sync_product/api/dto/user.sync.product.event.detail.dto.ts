import { ApiProperty } from '@nestjs/swagger';
import { IProductUseStatus } from '../../../product/interface/product.status';

export class UserSyncProductEventDetailDto {
  @ApiProperty({
    description: 'mapping id',
  })
  id: number;

  @ApiProperty({
    description: '등록일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  registerAt: string;

  @ApiProperty({
    description: '고객사 명',
  })
  businessUserName: string;

  @ApiProperty({
    description: '고객사 담당자',
  })
  businessPersonName: string;

  @ApiProperty({
    description: '상품 코드',
  })
  code: string;

  @ApiProperty({
    description: '대분류',
  })
  classification: string | null;

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
    description: '상품 사용 상태',
  })
  useStatus: IProductUseStatus;
}
