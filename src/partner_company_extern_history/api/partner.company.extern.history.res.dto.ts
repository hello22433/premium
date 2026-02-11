import { ApiProperty } from '@nestjs/swagger';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';

// 실패 유형
export enum FailType {
  PIN_ISSUE_FAIL = 'PIN_ISSUE_FAIL', // 핀 발급 실패
  SEND_FAIL = 'SEND_FAIL', // 발송 실패 (핀은 발급됨)
}

export class PartnerCompanyExternHistoryViewDto {
  @ApiProperty({ description: 'orderDelivery ID' })
  id: number;

  @ApiProperty({ description: '생성일시 (발송 요청일시)' })
  createdAt: string;

  @ApiProperty({ description: '협력사 타입', enum: IPartnerCompanyType, nullable: true })
  type: IPartnerCompanyType | null;

  @ApiProperty({ description: '협력사 타입명 (한글)', nullable: true })
  typeKo: string | null;

  @ApiProperty({ description: '발송상태', enum: [...Object.values(FailType), 'RESEND'] })
  failType: FailType | 'RESEND';

  @ApiProperty({ description: '발송상태명 (한글)' })
  failTypeKo: string;

  @ApiProperty({ description: '에러 코드 (context에서 추출)', nullable: true })
  errorCode: string | null;

  @ApiProperty({ description: '에러 메시지 (context에서 추출)', nullable: true })
  errorMessage: string | null;

  @ApiProperty({ description: 'transactionId', nullable: true })
  transactionId: string | null;

  @ApiProperty({ description: 'context 원본 (JSON)', nullable: true })
  context: string | null;

  @ApiProperty({ description: 'order_delivery.id' })
  orderDeliveryId: number;

  @ApiProperty({ description: '주문 코드', nullable: true })
  orderCode: string | null;

  @ApiProperty({ description: '이벤트명', nullable: true })
  eventName: string | null;

  @ApiProperty({ description: '수신처 (마스킹)', nullable: true })
  deliveryTarget: string | null;

  @ApiProperty({ description: '핀 발급 여부 (barCode 유무)' })
  pinIssued: boolean;

  @ApiProperty({ description: '재발송 완료 시각', nullable: true })
  resendAt: string | null;
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

export class ResendResultDto {
  @ApiProperty({ description: '성공 여부' })
  success: boolean;

  @ApiProperty({ description: '결과 메시지' })
  message: string;

  @ApiProperty({ description: 'orderDelivery ID', nullable: true })
  orderDeliveryId: number | null;
}
