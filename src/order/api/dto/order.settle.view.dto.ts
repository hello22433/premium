import { ApiProperty } from '@nestjs/swagger';
import { IOrderSettleDiscountType } from '../../interface/order.settle.discount.type';
import { IPriceAdjustment } from '../../../user_discount/interface/price.adjustment';

export class OrderSettleViewDto {
  @ApiProperty({
    description: 'order product mapping 의 id ',
  })
  // =================================
  id: number;

  @ApiProperty({
    description: '상품 브랜드 명',
  })
  // =================================
  brandName: string | null;

  @ApiProperty({
    description: '상품 명',
  })
  // =================================
  name: string;

  @ApiProperty({
    description: '수량',
  })
  // =================================
  amount: number;

  @ApiProperty({
    description: '정상단가',
  })
  // =================================
  price: number;

  @ApiProperty({
    description: '정상금액(정상단가 x 수량)',
  })
  // =================================
  totalPrice: number;

  @ApiProperty({
    description: '할인 구분 ex) 단건: ONE, 계약: CONTRACT',
  })
  // =================================
  settleDiscountType: IOrderSettleDiscountType | null;

  @ApiProperty({
    description: '할인 방법 ex) 할인: DISCOUNT, 할증: ADDITIONAL',
  })
  // =================================
  priceAdjustment: IPriceAdjustment | null;

  @ApiProperty({
    description: '수수료(%)',
  })
  // =================================
  fee: number | null;

  @ApiProperty({
    description: '할인 단가 (할인/할증 적용 후 단가) — deprecated: finalPrice 사용 권장',
  })
  // =================================
  discountPrice: number;

  @ApiProperty({
    description: '할인 금액 (할인/할증 적용 후 금액) — deprecated: finalPrice 사용 권장',
  })
  // =================================
  discountTotalPrice: number;

  @ApiProperty({
    description: '할인 금액 (정상금액 - 최종금액)',
  })
  // =================================
  discountAmount: number;

  @ApiProperty({
    description: '최종 금액 (할인/할증 적용 후 금액)',
  })
  // =================================
  finalPrice: number;

  @ApiProperty({
    description: '환불률 % (0: 환불불가, 80/90: 환불가능, null: 미설정)',
    nullable: true,
  })
  // =================================
  refund: number | null;

  @ApiProperty({
    description: 'SSG 가상 분리 행의 delivery ID 목록',
    nullable: true,
    required: false,
  })
  // =================================
  deliveryIds?: number[] | null;

  @ApiProperty({
    description: 'SSG 가상 분리 행 여부',
    nullable: true,
    required: false,
  })
  // =================================
  isSubRow?: boolean;
}
