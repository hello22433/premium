import { ApiProperty } from '@nestjs/swagger';
import { RealProductViewDto } from './real.product.view.dto';
import { PublicChargeTaxViewDto } from './public.charge.tax.view.dto';

export class OrderRealProductDetailDto {
  @ApiProperty({
    description: 'order id',
  })
  id: number;

  @ApiProperty({
    description: '등록 날짜 ex) yyyy-MM-ddTHH:mm:ss',
  })
  registerAt: string;

  @ApiProperty({
    description: '고객사 이름',
  })
  userBusinessName: string | null;

  @ApiProperty({
    description: '담당자 이름',
  })
  userName: string | null;

  @ApiProperty({
    description: '이벤트 명',
  })
  eventName: string;

  @ApiProperty({
    description: '주문 상품 내역 list',
  })
  orderRealProductList: RealProductViewDto[];

  @ApiProperty({
    description: '제세공과금 내역 list',
  })
  publicChargeTaxList: PublicChargeTaxViewDto[];
}
