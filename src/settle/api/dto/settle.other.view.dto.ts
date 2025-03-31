import { ApiProperty } from '@nestjs/swagger';

export class SettleOtherViewDto {
  @ApiProperty({
    description: 'other service sale id',
  })
  id: number;

  @ApiProperty({
    description: '등록일자 ex)yyyy-MM-ddTHH:mm:ss',
  })
  registerAt: string;

  @ApiProperty({
    description: '증빙일자 ex)yyyy-MM-ddTHH:mm:ss',
  })
  proveAt: string;

  @ApiProperty({
    description: '이벤트 명',
  })
  eventName: string;

  @ApiProperty({
    description: '고객사 이름',
  })
  businessName: string;

  @ApiProperty({
    description: '담당자 이름',
  })
  personName: string;

  @ApiProperty({
    description: '품목명',
  })
  productName: string;

  @ApiProperty({
    description: '판매유형 (string)',
  })
  type: string;

  @ApiProperty({
    description: '부가세 적용 여부 ex) true: 적용',
  })
  isVat: boolean;
}
