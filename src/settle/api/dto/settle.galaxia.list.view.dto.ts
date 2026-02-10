import { ApiProperty } from '@nestjs/swagger';

export class SettleGalaxiaListViewDto {
  @ApiProperty({ description: 'galaxia_barcode_log id' })
  id: number;

  @ApiProperty({ description: 'order_delivery id' })
  orderDeliveryId: number;

  @ApiProperty({ description: '바코드' })
  barcode: string;

  @ApiProperty({ description: '거래구분 코드 (10/20/25/81)' })
  appDiv: string;

  @ApiProperty({ description: '거래구분 한글' })
  appDivName: string;

  @ApiProperty({ description: '사용일자 (YYYYMMDD)' })
  appDay: string;

  @ApiProperty({ description: '사용시간 (HHmmss)' })
  appTime: string;

  @ApiProperty({ description: '사용금액' })
  amount: number;

  @ApiProperty({ description: '승인번호', nullable: true })
  appNo: string | null;

  @ApiProperty({ description: '사용처' })
  appStore: string;

  @ApiProperty({ description: '상품권 종류 (cpn/dept)' })
  giftKind: string;

  @ApiProperty({ description: '상품명' })
  productName: string;

  @ApiProperty({ description: '상품 정상가' })
  productPrice: number;

  @ApiProperty({ description: '현재 잔액' })
  galaxiaBalance: number;

  @ApiProperty({ description: '고객사 명' })
  userBusinessName: string;

  @ApiProperty({ description: '이벤트 명' })
  eventName: string;

  @ApiProperty({ description: 'EP 코드' })
  code: string;

  @ApiProperty({ description: '협력사 명' })
  partnerCompanyName: string;
}
