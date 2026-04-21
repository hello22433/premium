import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { ApiProperty } from '@nestjs/swagger';
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
    type: [ProductChoiceProductViewDto],
    description: '상품 pk 리스트',
  })
  // ================================
  productList: ProductChoiceProductViewDto[];
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
