import { ApiProperty } from '@nestjs/swagger';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';

/** 실패내역 한 행의 진실원천 (§8 화면 SoT 고정) */
export type DeliveryFailureSotSource = 'WORKFLOW' | 'LEGACY';

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

  @ApiProperty({
    description:
      '이 행의 진실원천. WORKFLOW=컷오버 전환 건(delivery_workflow), LEGACY=미전환 건(order_delivery.status)',
    enum: ['WORKFLOW', 'LEGACY'],
  })
  sotSource: DeliveryFailureSotSource;

  @ApiProperty({ description: 'workflow 업무 상태(전환 건만)', nullable: true })
  workflowStatus: string | null;

  @ApiProperty({ description: 'workflow 업무 상태명 (한글, 전환 건만)', nullable: true })
  workflowStatusKo: string | null;

  @ApiProperty({ description: '운영 확인 승격 사유(전환 건만)', nullable: true })
  opsReviewReason: string | null;

  @ApiProperty({ description: '발송 채널 (ALIM_TALK/SMS/MMS, 전환 건만)', nullable: true })
  channel: string | null;

  @ApiProperty({ description: '발송 원인 (전환 건만)', nullable: true })
  sendReason: string | null;

  @ApiProperty({ description: '자동 재발송 시도 횟수' })
  autoResendCount: number;

  @ApiProperty({ description: '수동 재발송 시도 횟수' })
  manualResendCount: number;

  @ApiProperty({ description: '실패 코드 설명 (코드표 기반)', nullable: true })
  failureCodeDescription: string | null;

  @ApiProperty({ description: '필요한 운영 조치', nullable: true })
  opsAction: string | null;

  @ApiProperty({ description: '마지막 확정 시각', nullable: true })
  lastResolvedAt: string | null;

  @ApiProperty({ description: '이 화면에서 재발송 버튼 활성화 가능 여부' })
  resendable: boolean;

  @ApiProperty({ description: '재발송 불가 사유', nullable: true })
  resendBlockReason: string | null;

  @ApiProperty({ description: 'legacy status 미러와 workflow SoT 판정이 불일치(§10 3단계 지표)' })
  mirrorMismatch: boolean;
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

  @ApiProperty({ description: '현재 페이지의 미러 불일치 건수 (§10 3단계 PASS 지표, 0이어야 정상)' })
  mirrorMismatchCount: number;

  @ApiProperty({
    description:
      '현재 페이지에서 무효한 날짜(제로날짜 등)를 만난 횟수. 0 이 정상이며, 0 이 아니면 그 컬럼을 채운 경로를 찾을 것. 값 자체는 폴백으로 채우므로 화면은 깨지지 않는다.',
  })
  invalidDateCount: number;
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

export class GetResendTargetIdsResDto {
  @ApiProperty({ description: '재발송 대상 orderDelivery ID 목록', type: [Number] })
  orderDeliveryIds: number[];

  @ApiProperty({ description: '전체 개수' })
  totalCount: number;
}
