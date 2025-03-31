import { ApiProperty } from '@nestjs/swagger';
import { IPartnerCompanySettleMethod } from '../../../partner_company/interface/partner.company.settle.method';

export class SettlePartnerCompanyListViewDto {
  @ApiProperty({
    description: '정산 order id',
  })
  id: number;

  @ApiProperty({
    description: '등록일자 ex)yyyy-MM-ddTHH:mm:ss',
  })
  registeredAt: string;

  @ApiProperty({
    description: '협력사 명',
  })
  partnerCompanyName: string;

  @ApiProperty({
    description: '고객사 회사 이름',
  })
  userBusinessName: string;

  @ApiProperty({
    description: '이벤트 명',
  })
  eventName: string;

  @ApiProperty({
    description: 'EP code',
  })
  code: string;

  @ApiProperty({
    description: '상품 이름',
  })
  productNameList: string[];

  @ApiProperty({
    description: '정상가',
  })
  deliveryPrice: number;

  @ApiProperty({
    description: '공급가',
  })
  settlePrice: number;

  @ApiProperty({
    description: '수수료율',
  })
  fee: number;

  @ApiProperty({
    description: '수수료 금액',
  })
  feePrice: number;

  @ApiProperty({
    description: '사용금액',
  })
  usePrice: number;

  @ApiProperty({
    description: '미사용금액',
  })
  unUsePrice: number;

  @ApiProperty({
    description: '정산방법',
    enum: IPartnerCompanySettleMethod,
  })
  settleMethod: IPartnerCompanySettleMethod;

  @ApiProperty({
    description: '교환 여부 true: 교환 false: 미 교환',
  })
  isTransfer: boolean;
}
