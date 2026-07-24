import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { ApiProperty } from '@nestjs/swagger';
import { ProductChoiceDetailProductViewDto } from './dto/product.choice.detail.product.view.dto';
import { ProductChoiceProductViewDto } from './dto/product.choice.product.view.dto';
import { ProductChoiceViewDto } from './dto/product.choice.view.dto';
import { ProductChoiceDetailDto } from './dto/product.choice.detail.dto';

export class ProductChoiceGetListResDto extends GetListResDto {
  @ApiProperty({
    type: [ProductChoiceViewDto],
    description: '초이스쿠폰 list',
  })
  list: ProductChoiceViewDto[];
}

export class ProductChoiceGetDetailResDto extends ProductChoiceDetailDto {
  @ApiProperty({
    type: [ProductChoiceDetailProductViewDto],
    description: '상품 pk 리스트. 삭제된 구성상품도 isDeleted 로 표시해 포함한다',
  })
  // ================================
  productList: ProductChoiceDetailProductViewDto[];

  @ApiProperty({
    description: '구성상품 중 사용 상태가 아니거나 삭제된 상품 존재 여부 (true: 비정상). 목록의 동일 필드와 같은 규칙',
  })
  hasUnusedProduct: boolean;
}

export class ProductChoiceGetProductListResDto extends GetListResDto {
  @ApiProperty({
    type: [ProductChoiceProductViewDto],
    description: '상품 list',
  })
  list: ProductChoiceProductViewDto[];
}

export class ProductChoiceDeleteCheckResDto {
  @ApiProperty({
    description: '발송 대기(WAIT) 상태 건수. 0이 아니면 삭제 불가',
  })
  waitCount: number;

  @ApiProperty({
    description: '발송 완료 후 고객이 아직 상품을 선택하지 않은 건수 (경고용)',
  })
  pendingCustomerCount: number;
}
