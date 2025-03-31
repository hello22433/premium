import { ApiProperty } from '@nestjs/swagger';
import { SettleOtherProductDetailDto } from './settle.other.product.dto';

export class SettleOtherDetailDto {
  @ApiProperty({ description: 'id' })
  id: number;

  @ApiProperty({ description: '고객사 담당자 id' })
  businessUserId: number;

  @ApiProperty({ description: '담당자 id' })
  userId: number;

  @ApiProperty({ description: '담당자 이름' })
  userName: string;

  @ApiProperty({ description: '고객사 회사명' })
  businessName: string;

  @ApiProperty({ description: '고객사 담당자 이름' })
  businessUserName: string;

  @ApiProperty({ description: '출하창고 id' })
  shippingStorageId: number;

  @ApiProperty({ description: '출하창고 이름' })
  shippingStorageName: string;

  @ApiProperty({ description: '판매유형 id' })
  saleTypeId: number;

  @ApiProperty({ description: '판매유형 이름' })
  saleTypeName: string;

  @ApiProperty({ description: '부가세 적용 여부' })
  isVat: boolean;

  @ApiProperty({ description: '이벤트 명' })
  eventName: string;

  @ApiProperty({ description: '이벤트 상세정보' })
  eventContent: string;

  @ApiProperty({ description: '특이사항' })
  etc: string | null;

  @ApiProperty({ description: '증빙일자 ex) yyyy-MM-dd' })
  proveAt: string;

  @ApiProperty({
    description: '상품 정보 리스트',
  })
  productList: SettleOtherProductDetailDto[];
}
