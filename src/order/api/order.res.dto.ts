import { OrderViewDto } from './dto/order.view.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { IOrderType } from '../interface/order.type';
import { OrderDetailProductDto, OrderPdfDetailProductDto } from './dto/order.detail.product.dto';
import { IOrderStatus } from '../interface/order.status';
import { OrderSettleViewDto } from './dto/order.settle.view.dto';
import { OrderCustomerViewDto } from './dto/order.customer.view.dto';
import { OrderCompleteReportViewDto } from './dto/order.complete.report.view.dto';
import { OrderDashboardViewDto } from './dto/order.dashboard.view.dto';
import { UserSettlePeriodConditionEnum } from '../../user/interface/user.settle.period.condition.enum';

export class OrderGetListResDto extends GetListResDto {
  @ApiProperty({
    description: '주문 list',
  })
  list: OrderViewDto[];
}

export class OrderCreateTempResDto {
  @ApiProperty({
    description: '생성된 order id',
  })
  id: number;
}

export class OrderGetDetailResDto {
  @ApiProperty({
    description: 'order id',
  })
  id: number;

  @ApiProperty({
    description: '등록일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  registerAt: string;

  @ApiProperty({
    description: '이벤트 명',
  })
  eventName: string;

  @ApiProperty({
    description: '주문 관리 타입',
  })
  type: IOrderType;

  @ApiProperty({
    description: '상단 이미지 경로',
  })
  topImagePath?: string;

  @ApiProperty({
    description: '중간 이미지 경로',
  })
  midImagePath?: string;

  @ApiProperty({
    enum: IOrderStatus,
    description: 'status',
  })
  status: IOrderStatus;

  @ApiProperty({
    description: '신세계 상품 유효기간',
  })
  couponExpiration: number | null;

  @ApiProperty({
    description: '상품 정보 리스트',
  })
  productList: OrderDetailProductDto[];

  @ApiProperty({
    description:
      '정산 조건 월 타입 ex) CURRENT_MONTH: 당월, NEXT_MONTH: 익월, NEXT_MONTH_AFTER: 익익월, DELIVERY_DATE: 발송일',
  })
  settlePeriodCondition: UserSettlePeriodConditionEnum | null;

  @ApiProperty({
    description: '발송 조건 일',
  })
  settlePeriodCount: number | null;

  @ApiProperty({
    description: '선정산 여부 (true: 선정산, false: 후정산)',
  })
  isPreSettle: boolean;

  @ApiProperty({
    description: '주문 취소 사유',
    nullable: true,
  })
  cancelReason: string | null;

  @ApiProperty({
    description: '주문 취소 일시 ex) yyyy-MM-ddTHH:mm:ss',
    nullable: true,
  })
  canceledAt: string | null;

  @ApiProperty({
    description: '해당 주문의 총 발송 실패 건수',
  })
  totalFailCount: number;

  @ApiProperty({
    description: '과금 대상 담당자 ID (대행주문 시)',
    nullable: true,
  })
  clientUserId: number | null;

  @ApiProperty({
    description: '과금 대상 담당자명 (대행주문 시)',
    nullable: true,
  })
  clientUserName: string | null;

  @ApiProperty({
    description: '과금 대상 담당자 회사명 (대행주문 시)',
    nullable: true,
  })
  clientCompanyName: string | null;

  @ApiProperty({
    description: '운영담당자 ID',
    nullable: true,
  })
  operationUserId: number | null;

  @ApiProperty({
    description: '운영담당자명',
    nullable: true,
  })
  operationUserName: string | null;
}

export class OrderGetDeliveryCompleteReportDetailResDto {
  @ApiProperty({
    description: 'order id',
  })
  id: number;

  @ApiProperty({
    description: '등록일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  registerAt: string;

  @ApiProperty({
    description: '이벤트 명',
  })
  eventName: string;

  @ApiProperty({
    description: '주문 관리 타입',
  })
  type: IOrderType;

  @ApiProperty({
    enum: IOrderStatus,
    description: 'status',
  })
  status: IOrderStatus;

  @ApiProperty({
    description: '신세계 상품 유효기간',
  })
  couponExpiration: number | null;

  @ApiProperty({
    description: '상품 정보 리스트',
  })
  productList: OrderPdfDetailProductDto[];
}

export class OrderSendInfoItemDto {
  @ApiProperty({
    description: '상품명',
  })
  productName: string;

  @ApiProperty({
    nullable: true,
    description: '발송 제목 (이벤트명)',
  })
  sendTitle: string | null;

  @ApiProperty({
    nullable: true,
    description: '발송 내용 (발송문구)',
  })
  sendContent: string | null;
}

export class OrderGetDeliveryCompleteReportResDto extends OrderGetDeliveryCompleteReportDetailResDto {
  @ApiProperty({
    description: 'pdf 파운로드시 파일명',
  })
  fileName: string;

  @ApiProperty({
    description: '고객사 정보',
  })
  userInfo: OrderCustomerViewDto;

  @ApiProperty({
    description: '개인정보 파기 요청일',
  })
  requestToDestroyPersonalInfoDay: number;

  @ApiProperty({
    nullable: true,
    description: '실제 발송 시간 ex) yyyy-MM-ddTHH:mm:ss',
  })
  actualSendAt: string | null;

  @ApiProperty({
    nullable: true,
    description: '발송 방법 ex) ALIM_TALK, SMS, EMAIL',
  })
  sendMethod: string | null;

  @ApiProperty({
    nullable: true,
    description: '발송 제목',
  })
  sendTitle: string | null;

  @ApiProperty({
    nullable: true,
    description: '발송 내용',
  })
  sendContent: string | null;

  @ApiProperty({
    nullable: true,
    description: '발송 요청 시간 ex) yyyy-MM-ddTHH:mm:ss',
  })
  sendRequestAt: string | null;

  @ApiProperty({
    nullable: true,
    description: '발신 전화번호',
  })
  fromPhoneNumber: string | null;

  @ApiProperty({
    nullable: true,
    description: '발신 이메일',
  })
  fromEmail: string | null;

  @ApiProperty({
    nullable: true,
    description: '독려 문자 발송 일',
  })
  encourageDay: number | null;

  @ApiProperty({
    type: [OrderSendInfoItemDto],
    nullable: true,
    description: '상품별 발송정보 목록',
  })
  sendInfoList: OrderSendInfoItemDto[] | null;
}

export class OrderGetOrderCompleteReportResDto extends OrderCompleteReportViewDto {}

export class OrderDeliveryConfirmed {
  @ApiProperty({
    description:
      '메세지 ex) 전체 성공 : success, 일부 실패가 존재하는 경우 : fail, 한도 초과(1차) : credit_excess, ' +
      '신용초과 사전 승인 필요(WALLET 모드 2차) : credit_excess_pending_approval',
  })
  message: string;

  @ApiPropertyOptional({ description: '한도 초과 여부' })
  creditExcess?: boolean;

  @ApiPropertyOptional({ description: '초과 금액 (= requestedCreditExcessAmount)' })
  excessAmount?: number;

  @ApiPropertyOptional({ description: '잔여 한도' })
  remainServiceAmount?: number;

  @ApiPropertyOptional({ description: '필요 금액 (= requestedAmount)' })
  finalAmount?: number;

  /**
   * WALLET 모드 credit_excess_pending_approval 응답 시 함께 반환.
   * 클라이언트는 본 값들을 POST /credit-excess-approvals 요청 body 에 그대로 전달.
   */
  @ApiPropertyOptional({ description: 'wallet_account ID (BIGINT 직렬화 string)' })
  walletAccountId?: string;

  @ApiPropertyOptional({ description: '신용초과 사전 승인 요청 금액 (= excessAmount)' })
  requestedCreditExcessAmount?: number;

  @ApiPropertyOptional({ description: '신용초과 사전 승인 총 청구 금액 (= finalAmount)' })
  requestedAmount?: number;
}

export class OrderGetSettleGetListResDto extends GetListResDto {
  @ApiProperty({
    description: '정산 정보 list',
  })
  list: OrderSettleViewDto[];

  @ApiProperty({
    description: '고객사 정산방법 ex) CARD, CASH',
    nullable: true,
  })
  settleMethod: string | null;

  @ApiProperty({
    description: '카드할증 적용 여부',
  })
  cardSurchargeApplied: boolean;

  @ApiProperty({
    description: 'SSG 가상 행 포함 총 건수 (페이지네이션 참고용)',
    required: false,
  })
  virtualTotalCount?: number;

  @ApiProperty({
    description: '전체 할인 후 총 금액 (페이지네이션과 무관한 전체 합계)',
  })
  totalDiscountAmount: number;

  @ApiProperty({
    description: '카드할증 산정 기준액 (할인 후 총액 = totalDiscountAmount)',
  })
  cardSurchargeBase: number;

  @ApiProperty({
    description: '카드할증액 (10원 절사 포함). 미적용 시 0',
  })
  cardSurchargeAmount: number;

  @ApiProperty({
    description: '카드할증 포함 최종 결제 금액 (= cardSurchargeBase + cardSurchargeAmount)',
  })
  payableSettlementAmount: number;
}

export class OrderGetMyOrderHistoryResDto extends OrderDashboardViewDto {}

export class OrderGetPreviousContentResDto {
  @ApiProperty({
    description: '발송 제목',
  })
  sendTitle: string | null;

  @ApiProperty({
    description: '발송 내용 ',
  })
  sendContent: string | null;
}

export class OrderReportHistoryItemDto {
  @ApiProperty({
    description: '다운로드한 사용자 이메일',
  })
  userEmail: string;

  @ApiProperty({
    description: '다운로드 일시',
  })
  createdAt: string;

  @ApiProperty({
    description: '발행 소스 (DOCUMENT: 문서함, DIRECT: 직접발행)',
    nullable: true,
  })
  source: string | null;

  @ApiProperty({
    description: '이메일 수신자 (이메일 발송 시)',
    nullable: true,
  })
  to: string | null;

  @ApiProperty({
    description: '이메일 참조 (이메일 발송 시)',
    nullable: true,
  })
  cc: string | null;
}

export class OrderGetReportHistoryResDto {
  @ApiProperty({
    type: [OrderReportHistoryItemDto],
    description: '다운로드 이력 목록',
  })
  list: OrderReportHistoryItemDto[];
}

// ============================================================
// 발송 중복 검증(감사) DTO
// ============================================================

export class OrderDeliveryAuditSummaryDto {
  @ApiProperty({ description: '전체 order_delivery 레코드 수' })
  totalDeliveryRows: number;

  @ApiProperty({ description: '고유 수신번호(deliveryTarget) 수' })
  uniqueTargetCnt: number;

  @ApiProperty({ description: 'COMPLETE 건수' })
  completeCnt: number;

  @ApiProperty({ description: 'COMPLETE_SMS (알림톡→SMS 대체 성공) 건수' })
  completeSmsCnt: number;

  @ApiProperty({ description: 'FAIL 건수' })
  failCnt: number;

  @ApiProperty({ description: 'FAIL_SMS 건수' })
  failSmsCnt: number;

  @ApiProperty({ description: 'TEMP/WAIT 등 대기 상태 건수' })
  pendingCnt: number;

  @ApiProperty({ description: '그 외 상태 건수 (CANCEL 등)' })
  otherCnt: number;

  @ApiProperty({ description: 'actualSendAt 이 채워진 실제 발송 건수' })
  sentCnt: number;

  @ApiProperty({ description: '재발송 완료(resendAt 존재) 건수' })
  resentCnt: number;

  @ApiProperty({ description: '폐기 후 신규 발송(replacedFromId 존재) 건수' })
  replacedCnt: number;
}

export class OrderDeliveryAuditDailyDto {
  @ApiProperty({ description: '실제 발송 일자 (yyyy-MM-dd)' })
  sendDate: string;

  @ApiProperty({ description: '해당 일자 발송 건수' })
  sendCnt: number;

  @ApiProperty({ description: '해당 일자 고유 수신번호 수' })
  uniquePhoneCnt: number;

  @ApiProperty({ description: '재발송 포함 건수' })
  resentCnt: number;

  @ApiProperty({
    description: '이상 감지 여부 (재발송 제외 발송 건수가 고유 번호 수보다 많을 때 true)',
  })
  isSuspicious: boolean;
}

export class OrderDeliveryAuditDuplicateDto {
  @ApiProperty({ description: '수신번호(복호화됨)' })
  deliveryTarget: string;

  @ApiProperty({ description: '같은 수신번호로 존재하는 order_delivery 레코드 수' })
  rowCnt: number;

  @ApiProperty({ description: '그 중 실제 발송(actualSendAt 채워진) 건수' })
  sentCnt: number;

  @ApiProperty({ type: [Number], description: 'order_delivery.id 목록' })
  deliveryIds: number[];

  @ApiProperty({ type: [String], description: '각 레코드의 status' })
  statuses: string[];

  @ApiProperty({ type: [String], description: '각 레코드의 actualSendAt (null 가능)' })
  sendTimes: (string | null)[];

  @ApiProperty({ type: [String], description: '각 레코드의 resendAt (null 가능)' })
  resendTimes: (string | null)[];

  @ApiProperty({
    type: [Number],
    description: '각 레코드의 replacedFromId (null 가능). 값이 있으면 "폐기 후 신규 발송"이라 정상 중복',
  })
  replacedFromIds: (number | null)[];

  @ApiProperty({
    description: '정상 중복 여부. replacedFromId 가 하나라도 채워져 있으면 true (정상적인 폐기→재발행)',
  })
  isLegitimate: boolean;
}

export class OrderDeliverySsgDuplicateDto {
  @ApiProperty({
    enum: ['ssgTransactionId', 'barCode'],
    description: '중복 필드',
  })
  field: 'ssgTransactionId' | 'barCode';

  @ApiProperty({ description: '중복된 값' })
  value: string;

  @ApiProperty({ description: '중복 건수' })
  cnt: number;

  @ApiProperty({ type: [Number], description: 'order_delivery.id 목록' })
  deliveryIds: number[];
}

export class OrderGetDeliveryAuditResDto {
  @ApiProperty({ description: 'order id' })
  orderId: number;

  @ApiProperty({ description: '이벤트 명' })
  eventName: string;

  @ApiProperty({ enum: IOrderType, description: '주문 타입' })
  orderType: IOrderType;

  @ApiProperty({ enum: IOrderStatus, description: '주문 상태' })
  orderStatus: IOrderStatus;

  @ApiProperty({
    description:
      '중복 발송 감지 여부. (비정상 중복 레코드 / 일자별 이상 / SSG PIN 중복 중 하나라도 있으면 true)',
  })
  isDuplicateDetected: boolean;

  @ApiProperty({ type: OrderDeliveryAuditSummaryDto, description: '전체 요약 통계' })
  summary: OrderDeliveryAuditSummaryDto;

  @ApiProperty({ type: [OrderDeliveryAuditDailyDto], description: '일자별 발송 통계' })
  dailyStats: OrderDeliveryAuditDailyDto[];

  @ApiProperty({
    type: [OrderDeliveryAuditDuplicateDto],
    description: '동일 수신번호로 2건 이상 존재하는 레코드 상세',
  })
  duplicates: OrderDeliveryAuditDuplicateDto[];

  @ApiProperty({
    type: [OrderDeliverySsgDuplicateDto],
    description: 'SSG 주문 한정 — ssgTransactionId / barCode 중복 상세',
  })
  ssgDuplicates: OrderDeliverySsgDuplicateDto[];
}
