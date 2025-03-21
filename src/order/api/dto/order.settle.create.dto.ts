import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsNumber, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { IOrderSettleDiscountType } from '../../interface/order.settle.discount.type';
import { IPriceAdjustment } from '../../../user_discount/interface/price.adjustment';

export class OrderSettleCreateDto {
  @ApiProperty({
    description: 'order product mapping id',
  })
  // ==============================================
  @IsNumber()
  @IsNotEmpty()
  @Type(() => Number)
  id: number;

  @ApiProperty({
    description: '할인 구분 ex) 단건: ONE, 계약: CONTRACT',
  })
  // =============================
  @IsEnum(IOrderSettleDiscountType)
  @IsNotEmpty()
  settleDiscountType: IOrderSettleDiscountType;

  @ApiProperty({
    description: '할인 방법 ex) 할인: DISCOUNT, 할증: ADDITIONAL',
  })
  // =============================
  @IsEnum(IPriceAdjustment)
  @IsNotEmpty()
  priceAdjustment: IPriceAdjustment;

  @ApiProperty({
    description: '수수료 %',
  })
  // =============================
  @IsNumber()
  @IsNotEmpty()
  @Min(1, { message: '수수료는 최소 1% 이상이어야 합니다.' })
  @Max(100, { message: '수수료는 최대 100% 이하여야 합니다.' })
  fee: number;
}
