import { ApiProperty } from '@nestjs/swagger';
import { SettleProductDetailDto } from './settle.product.detail.dto';

export class SettleProductViewDto {
  @ApiProperty({
    description: 'order product mapping id',
  })
  id: number;

  @ApiProperty({
    description: '정산 상품 정보',
  })
  product: SettleProductDetailDto | null;
}
