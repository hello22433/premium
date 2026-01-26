import { ApiProperty } from '@nestjs/swagger';

export class PopularProductItemDto {
  @ApiProperty({ description: '순위' })
  rank: number;

  @ApiProperty({ description: '상품 ID' })
  productId: number;

  @ApiProperty({ description: '상품명' })
  productName: string;

  @ApiProperty({ description: '브랜드명' })
  brandName: string;

  @ApiProperty({ description: '상품 이미지 경로' })
  imagePath: string;

  @ApiProperty({ description: '고유 고객사 수' })
  uniqueCompanyCount: number;

  @ApiProperty({ description: '총 발송 건수' })
  totalQuantity: number;

  @ApiProperty({ description: '집계 기준일' })
  calculatedAt: Date;
}

export class PopularProductGetListResDto {
  @ApiProperty({ type: [PopularProductItemDto], description: '주간 인기상품 목록' })
  list: PopularProductItemDto[];
}