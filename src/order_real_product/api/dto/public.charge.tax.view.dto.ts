import { ApiProperty } from '@nestjs/swagger';
import { IPublicChargeTaxPaymentType } from '../../interface/public.charge.tax.payment.type';
import { IProcessMethod } from '../../interface/process.method';

export class PublicChargeTaxViewDto {
  @ApiProperty({
    description: 'order real product mapping id',
  })
  mappingId: number;

  @ApiProperty({
    description: 'product id',
  })
  productId: number;

  @ApiProperty({
    description: '상품명',
  })
  productName: string;

  @ApiProperty({
    description: '상품 코드',
  })
  code: string;

  @ApiProperty({
    description: '수량',
  })
  quantity: number;

  @ApiProperty({
    description: '기준가액',
  })
  standardAmount: number;

  @ApiProperty({
    description: '납세액(기준가액의 10%)',
  })
  tax: number;

  @ApiProperty({
    description: '합계 금액',
  })
  totalTaxAmount: number;

  @ApiProperty({
    description: '제세공과금 납부 방법 ex) PERSON: 고객납부, COMPANY: 고객사대납',
  })
  publicChargeTaxPaymentType: IPublicChargeTaxPaymentType;

  @ApiProperty({
    description: '처리 방식 ex) PRE: 사전처리, POST: 사후처리',
  })
  processMethod: IProcessMethod;

  @ApiProperty({
    description: '처리 여부 ex) 처리: true, 미처리: false',
  })
  isProcess: boolean;
}
