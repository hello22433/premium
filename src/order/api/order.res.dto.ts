import { CustomerSettlementViewDto, OrderViewDto } from './dto/order.view.dto';
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
import { SsgBalanceCheckView } from '../../ssg_event/application/ssg.balance.guard';

export class OrderGetListResDto extends GetListResDto {
  @ApiProperty({
    description: '주문 list',
  })
  list: OrderViewDto[];
}

/**
 * 발송관리 고객사 정산정보(호버 툴팁) 응답.
 * 정산코드 미부여 / wallet_account 미존재 주문은 목록에서 생략된다.
 */
export class OrderGetCustomerSettlementResDto {
  @ApiProperty({
    description: '주문별 고객사 정산정보 list',
    type: [CustomerSettlementViewDto],
  })
  list: CustomerSettlementViewDto[];
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
    description: '해당 주문의 총 미해결 발송 실패 건수 (재발송 완료 건 제외)',
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

  @ApiPropertyOptional({
    description:
      'SSG 행사잔액 이상 탐지 결과. 발송확정 전(REVIEW_COMPLETE) SSG 주문 + 발송확정 권한자에게만 존재. ' +
      'hasWarning=true면 발송확정 시 팝업 경고(강행 가능). lookupFailed=true면 신세계 조회 불가(수동확인 권장).',
  })
  ssgBalanceCheck?: SsgBalanceCheckView;
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
    description:
      '개인정보 파기 요청일수. ⚠️ 주문의 **첫 번째 상품매핑 값**이다(대표값). 파기일수는 상품별로 ' +
      '승계되므로 다상품 주문에서 상품마다 다를 수 있고, 그때 이 값은 주문 전체를 대표하지 않는다. ' +
      '파기 시점이 필요하면 전 매핑을 반영한 effectiveDestroyAt 을 쓸 것 — 이 값으로 날짜를 자체 ' +
      '계산하면(발송일 + 이 일수) 유효기간 가드와 다상품 편차가 모두 반영되지 않는다.',
  })
  requestToDestroyPersonalInfoDay: number;

  @ApiProperty({
    nullable: true,
    description:
      '실효 개인정보 파기일 ex) yyyy-MM-dd. **이미 파기된 건은 실적일, 아직 파기되지 않은 건은 예정일**이다. ' +
      '① 이미 파기된 건 → order_delivery.destroyed_at, 즉 **실제로 지운 날**이다(정기·조기 공통). ' +
      '파기확인서의 파기일 칸에 쓸 수 있는 것은 이 경우이며, 판별은 effectiveDestroyAtKind 로 한다. ' +
      '② 아직 파기되지 않은 건 → `MAX(발송요청일 + 파기일수, 유효기간 만료일 + 1일)` 로 계산한 **예정일**이다 ' +
      '(만료 당일은 아직 유효하므로 +1일). **지금 조건이 유지될 때의 추정치**이며 확정도 하한도 아니다 — ' +
      '환불 진행중이거나 배치 회차가 유실되면 뒤로 밀리고, 주문이 발송완료 상태를 이탈하면 파기되지 않는데도 ' +
      '날짜는 계속 표시된다. 반대로 폐기후재발행 되감기(soft-delete)나 파기일수 하향 편집이 있으면 앞당겨진다. ' +
      '①인지 ②인지는 effectiveDestroyAtKind 로 구분한다. ' +
      '유효기간이 파기예정일보다 뒤인 상품(예: 유효기간 5년 / 파기 180일)은 만료 다음 날까지 파기가 ' +
      '보류되므로 requestToDestroyPersonalInfoDay 로 자체 계산한 날짜와 다르다. ' +
      '주문에 발송건이 여러 개면 그중 가장 늦은 날짜(= 이 날이면 전부 지워져 있다). ' +
      '⚠️⚠️ **null 이면 파기일 칸을 비우고 자체 계산으로 채우지 말 것.** ' +
      'null 은 "이 주문의 파기일을 확정할 수 없다"는 뜻이며, 종전 계산식(`발송일 + 파기일수`)으로 ' +
      '채우는 것은 **금지**한다. 그 식이 바로 이 필드를 만들게 된 오류의 원인이기 때문이다 — ' +
      '파기 규칙이 `MAX(발송일 + 파기일수, 유효기간 만료일 + 1일)` 로 바뀐 뒤에도 옛 식으로 계산하면 ' +
      '이미 파기된 건에 수년 뒤 날짜가 인쇄된다. 서버가 "모른다"고 답한 자리를 클라이언트가 ' +
      '추측으로 메우면 그 추측이 대외 증빙 문서에 사실처럼 실린다. ' +
      'null 일 때는 빈 칸 또는 "확인 필요" 안내로 표시하고, 필요하면 운영에 문의하도록 유도할 것. ' +
      'null 이 되는 경우는 대표적으로 다음과 같다: ' +
      '(가) 파기일수/발송요청일이 결측이라 예정일을 계산할 수 없는 건 — 지금 값이 유지되는 한 정기파기 ' +
      '배치가 그 행을 집지 않으므로 파기 예정일이 존재하지 않는다(값이 나중에 채워지면 달라진다). ' +
      '(나) **이미 파기됐는데 파기 시각 기록이 없는 건** — 지운 것은 확실하나 언제인지 모른다. ' +
      '(다) 발송건이 하나도 없는 주문(증명할 내용이 없다). 통합 보고서는 여기에 더해 **주문 하나라도 ' +
      'null 이면 전체가 null** 이다. ' +
      '⚠️ (가) 중 **첫 번째 매핑의** 파기일수가 결측인 경우에만 requestToDestroyPersonalInfoDay 가 0 으로 ' +
      '내려간다(다상품 주문에서는 180 등이 그대로 내려갈 수 있으므로 "0이면 (가)"라는 판별식을 만들지 말 것). 그 값으로 ' +
      '`발송일 + 0일`을 계산하면 발송 당일이 파기일로 표시되므로(실제로는 영구 미파기다) ' +
      '자체 계산이 얼마나 위험한지 보여주는 사례다.',
  })
  effectiveDestroyAt: string | null;

  @ApiProperty({
    nullable: true,
    enum: ['ACTUAL', 'ACTUAL_ESTIMATED', 'SCHEDULED'],
    description:
      'effectiveDestroyAt 의 **근거 강도**. 같은 yyyy-MM-dd 라도 성격이 달라 날짜만으로는 구분할 수 없다. ' +
      '· ACTUAL = 이미 파기됐고 그 시각이 기록돼 있다(실측). **파기확인서의 파기일 칸에 쓸 수 있는 것은 이 경우다.** ' +
      '· ACTUAL_ESTIMATED = 이미 파기됐지만 시각은 추정이다(컬럼 신설 전에 파기된 건을 옛 규칙으로 역산한 값). ' +
      '날짜는 그럴듯하나 실측이 아니므로 증빙에 쓸 때 주의가 필요하다. ' +
      '· SCHEDULED = 아직 파기되지 않았다. 배치가 파기할 수 있는 가장 이른 날이며 확정이 아니다. ' +
      '⚠️ 주문(통합 보고서는 여러 주문) 단위 값이므로 **구성 발송건 중 가장 약한 것**이 올라온다 — ' +
      '실적 하나 + 예정 하나면 SCHEDULED 다. "이 날이면 전부 지워져 있다"는 진술은 가장 불확실한 ' +
      '구성요소만큼만 강하기 때문이다. effectiveDestroyAt 이 null 이면 이 값도 null 이다.',
  })
  effectiveDestroyAtKind: 'ACTUAL' | 'ACTUAL_ESTIMATED' | 'SCHEDULED' | null;

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

export class OrderGetDeliveryCompleteReportMultipleResDto extends OrderGetDeliveryCompleteReportResDto {
  @ApiProperty({
    type: [Number],
    description: '통합 대상 주문 id 목록',
  })
  orderIds: number[];
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

  // ===== Wallet PR3: success 응답 분배 상세 (WALLET 모드). LEGACY 는 0/null 통일 =====
  @ApiPropertyOptional({ description: '적용된 포인트 사용액' })
  pointUsedAmount?: number;

  @ApiPropertyOptional({ description: '적용된 예치금 사용액' })
  depositUsedAmount?: number;

  @ApiPropertyOptional({ description: '여신 사용액' })
  creditUsedAmount?: number;

  @ApiPropertyOptional({ description: '신용초과 금액' })
  creditExcessAmount?: number;

  @ApiPropertyOptional({ description: '카드할증 기준 금액' })
  cardSurchargeBase?: number;

  @ApiPropertyOptional({ description: '카드할증 금액' })
  cardSurchargeAmount?: number;

  @ApiPropertyOptional({ description: '최종 결제 금액 (= base + surcharge)' })
  payableSettlementAmount?: number;
}

export class OrderAllocationPreviewResDto {
  @ApiProperty({ description: 'wallet_account ID (BIGINT 직렬화 string)' })
  walletAccountId: string;

  @ApiProperty({ description: '선/후정산', enum: ['PRE_PAYMENT', 'POST_PAYMENT'] })
  settleCondition: 'PRE_PAYMENT' | 'POST_PAYMENT';

  @ApiProperty({ description: '총 정산 기준금액' })
  grossSettlementAmount: number;

  @ApiProperty({ description: '포인트 사용 가능 금액 (ALLOW 라인 합)' })
  pointAllowableAmount: number;

  @ApiProperty({ description: '포인트 사용 불가 금액 (DENY 라인 합)' })
  pointDeniedAmount: number;

  @ApiProperty({ description: '적용된 포인트 사용액' })
  pointUsedAmount: number;

  @ApiProperty({ description: '예치금 현재 잔액' })
  depositBalance: number;

  @ApiProperty({ description: '적용된 예치금 사용액' })
  depositUsedAmount: number;

  @ApiProperty({ description: '여신 사용액' })
  creditUsedAmount: number;

  @ApiProperty({ description: '신용초과 금액' })
  creditExcessAmount: number;

  @ApiProperty({ description: '카드할증 적용 여부' })
  cardSurchargeApplied: boolean;

  @ApiProperty({ description: '카드할증 기준 금액' })
  cardSurchargeBase: number;

  @ApiProperty({ description: '카드할증 금액' })
  cardSurchargeAmount: number;

  @ApiProperty({ description: '최종 결제 금액 (= base + surcharge)' })
  payableSettlementAmount: number;
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
    description: '중복 발송 감지 여부. (비정상 중복 레코드 / 일자별 이상 / SSG PIN 중복 중 하나라도 있으면 true)',
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
