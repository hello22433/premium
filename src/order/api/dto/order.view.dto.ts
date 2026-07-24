import { IOrderStatus } from '../../interface/order.status';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IOrderDeliveryStatus } from '../../../delivery/interface/order.delivery.status';
import { DestructionCertificateBlockReason } from '../../interface/destruction.certificate.block.reason';

export class CustomerSettlementDto {
  @ApiProperty({
    description: '정산조건 ex) 선정산: PRE_PAYMENT, 후정산: POST_PAYMENT',
    enum: ['PRE_PAYMENT', 'POST_PAYMENT'],
  })
  settleCondition: 'PRE_PAYMENT' | 'POST_PAYMENT';

  @ApiProperty({
    nullable: true,
    description: '잔여 서비스 한도 (원 단위 정수, 0-clamp). 계산 불가 시 null',
  })
  remainServiceAmount: number | null;
}

export class OrderViewDto {
  @ApiProperty({
    description: 'order id',
  })
  id: number;

  @ApiProperty({
    description: '등록 날짜 ex) yyyy-MM-ddTHH:mm:ss',
  })
  registerAt: string;

  @ApiProperty({
    description: '고객사 이름',
  })
  userBusinessName: string;

  @ApiProperty({
    description: '담당자 이름',
  })
  userPersonName: string;

  @ApiProperty({
    description: '이벤트 명',
  })
  eventName: string;

  @ApiProperty({
    description: '상품명, 권 종',
  })
  productName: string;

  @ApiProperty({
    description: '품목 수량 ',
  })
  totalProductCount: number;

  @ApiProperty({
    description: '발송 수량 = 총 발송 수량',
  })
  totalAmount: number;

  @ApiProperty({
    description: '진행 상태',
  })
  status: IOrderStatus;

  @ApiProperty({
    description: '발송 요청 시간 (예약 시간) ex) yyyy-MM-ddTHH:mm:ss',
  })
  sendRequestAt: string | null;

  @ApiProperty({
    nullable: true,
    description: '실제 발송 시간 ex) yyyy-MM-ddTHH:mm:ss',
  })
  actualSendAt: string | null;

  @ApiProperty({
    nullable: true,
    description: '운영 담당자 user id',
  })
  operationUserId: number | null;

  @ApiProperty({
    nullable: true,
    description: '운영 담당자 user 명칭',
  })
  operationUserName: string | null;

  @ApiProperty({
    description: '발송 금액',
  })
  deliveryPrice: number;

  @ApiProperty({
    description: '정산 금액',
  })
  settlePrice: number;

  @ApiProperty({
    description: '개인정보 파기 요청일',
  })
  requestToDestroyPersonalInfoDay: number;

  @ApiProperty({
    nullable: true,
    description: '발송 방식 ex) IMMEDIATE: 즉시발송, RESERVE: 예약발송',
  })
  sendType: string | null;

  @ApiProperty({
    description: '발송 실패 건 포함 여부',
  })
  hasFailedDelivery: boolean;

  @ApiProperty({
    description: '재발송 완료 건 포함 여부',
  })
  hasResentDelivery: boolean;

  @ApiProperty({
    description: '파기확인서 발행 가능 여부 (발송 완료 + 모든 발송건의 개인정보 파기 완료)',
  })
  canIssueDestructionCertificate: boolean;

  @ApiProperty({
    enum: DestructionCertificateBlockReason,
    nullable: true,
    description: '파기확인서 발행 불가 사유. null 이면 발행 가능',
  })
  destructionCertificateBlockReason: DestructionCertificateBlockReason | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description:
      '혼합 발송(IMMEDIATE+RESERVE) 또는 RESERVE 분 단위 예약시각 2종 이상일 때 채움. 각 항목: productName(상품명), sendType(IMMEDIATE|RESERVE), sendRequestAt(예약시각 KST; IMMEDIATE·draft RESERVE는 null), actualSendAt(실제 발송시각 KST; 미발송 null)',
  })
  productSendTimes?: {
    productName: string;
    sendType: 'IMMEDIATE' | 'RESERVE';
    sendRequestAt: string | null;
    actualSendAt: string | null;
  }[];

  @ApiPropertyOptional({
    nullable: true,
    type: CustomerSettlementDto,
    description:
      '고객사 정산 정보. wallet_account 미존재 시 필드 생략. SUPER_ADMIN/OPERATION_ADMIN 조회 + includeSettlement=true 일 때만 포함.',
  })
  customerSettlement?: CustomerSettlementDto;
}
