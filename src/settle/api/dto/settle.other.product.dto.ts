import { ApiProperty } from '@nestjs/swagger';

export class SettleOtherProductDetailDto {
  @ApiProperty({
    description: '매핑 id (수정 시 이 값을 mappingId 로 전송)',
  })
  mappingId: number;

  @ApiProperty({
    description: '품목 마스터 id',
  })
  productId: number;

  @ApiProperty({
    deprecated: true,
    description: '[deprecated] productId 와 동일. 프론트 전환 기간만 유지 후 제거 예정',
  })
  id: number;

  @ApiProperty({
    description: '품목 코드',
  })
  code: string;

  @ApiProperty({
    description: '브랜드 명',
  })
  brandName: string;

  @ApiProperty({
    description: '품목명',
  })
  productName: string;

  @ApiProperty({
    description: '수량',
  })
  quantity: number;

  @ApiProperty({
    description: '단가',
  })
  price: number;

  @ApiProperty({
    description: '공급가(수량 x 단가)',
  })
  totalPrice: number;
}
