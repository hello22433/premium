import { ApiProperty } from '@nestjs/swagger';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';

export class PartnerCompanyExternHistoryViewDto {
  @ApiProperty({ description: 'ID' })
  id: number;

  @ApiProperty({ description: '생성일시' })
  createdAt: string;

  @ApiProperty({ description: '협력사 타입', enum: IPartnerCompanyType })
  type: IPartnerCompanyType;

  @ApiProperty({ description: '협력사 타입명 (한글)' })
  typeKo: string;

  @ApiProperty({ description: '성공 여부' })
  isSuccess: boolean;

  @ApiProperty({ description: '에러 코드 (context에서 추출)', nullable: true })
  errorCode: string | null;

  @ApiProperty({ description: '에러 메시지 (context에서 추출)', nullable: true })
  errorMessage: string | null;

  @ApiProperty({ description: 'transactionId (context에서 추출)', nullable: true })
  transactionId: string | null;

  @ApiProperty({ description: 'context 원본 (JSON)' })
  context: string;

  @ApiProperty({ description: 'order_delivery.id', nullable: true })
  orderDeliveryId: number | null;

  @ApiProperty({ description: '주문 코드', nullable: true })
  orderCode: string | null;

  @ApiProperty({ description: '이벤트명', nullable: true })
  eventName: string | null;

  @ApiProperty({ description: '수신처 (마스킹)', nullable: true })
  deliveryTarget: string | null;
}

export class GetPartnerCompanyExternHistoryListResDto {
  @ApiProperty({ type: [PartnerCompanyExternHistoryViewDto], description: '히스토리 목록' })
  list: PartnerCompanyExternHistoryViewDto[];

  @ApiProperty({ description: '전체 개수' })
  totalCount: number;

  @ApiProperty({ description: '전체 페이지 수' })
  totalPage: number;

  @ApiProperty({ description: '현재 페이지' })
  currentPage: number;
}

export class GetPartnerCompanyTypesResDto {
  @ApiProperty({
    type: [Object],
    description: '협력사 타입 목록',
    example: [{ value: 'GALAXIA', label: '갤럭시아' }],
  })
  types: { value: string; label: string }[];
}
