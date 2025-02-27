import { ApiProperty } from '@nestjs/swagger';
import { IUserDiscountCategory } from '../../interface/user.discount.category';

export class UserDiscountViewDto {
  @ApiProperty({
    description: 'user discount id',
  })
  id: number;

  @ApiProperty({
    description: '유저 id',
  })
  userId: number | null;

  @ApiProperty({
    description: '협력사 id',
  })
  partnerCompanyId: number | null;

  @ApiProperty({
    description: '할인 분류 ex) 상품군: CATEGORY, 대분류: CLASSIFICATION',
  })
  category: IUserDiscountCategory;

  @ApiProperty({
    description: '할인 방법',
  })
  method: string;

  @ApiProperty({
    description: '대분류',
  })
  primaryCategory: string | null;

  @ApiProperty({
    description: '상품군',
  })
  group: string | null;

  @ApiProperty({
    description: '구간',
  })
  range: string | null;

  @ApiProperty({
    description: '비교 조건',
  })
  compareCondition: string;

  @ApiProperty({
    description: '할인 or 할증',
  })
  priceAdjustment: string;

  @ApiProperty({
    description: '수수료(%)',
  })
  pricePercent: number;
}
