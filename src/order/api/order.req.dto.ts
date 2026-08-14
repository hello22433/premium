import { IOrderStatus } from '../interface/order.status';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { dateAtRegexp } from '../../common/domain/date.regexp';
import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { OrderCreateDto } from './dto/order.create.dto';
import { IOrderType } from '../interface/order.type';
import { IOrderSection } from '../interface/order.section';
import { Transform, Type } from 'class-transformer';
import { OrderSettleCreateDto } from './dto/order.settle.create.dto';
import { IOrderSendingType } from '../interface/order.sending.type';
import {
  CLIENT_SETTABLE_REPORT_SOURCES,
  IReportHistoryType,
  IReportSource,
  REPORT_HISTORY_TYPES,
} from '../interface/report.source';
import { IOrderDateType } from '../interface/order.date.type';
import { CompanyType } from '../../common/domain/company.type';

export class OrderGetListReqDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '구분 ex) 주문관리 : ORDER, 발송관리: SHIPPING',
    default: IOrderSection.ORDER,
  })
  // ==============================================
  @IsEnum(IOrderSection)
  section: IOrderSection = IOrderSection.ORDER;

  @ApiProperty({
    description: '주문 타입 ex) 일반: GENERAL, 신세계: SSG, 맞춤형: CUSTOM',
    default: 'GENERAL',
  })
  // ==============================================
  @IsEnum(IOrderType)
  type: IOrderType = IOrderType.GENERAL;

  @ApiPropertyOptional({
    description:
      '발송 상태 <br>' +
      'TEMP : 임시 저장<br>' +
      '  DELIVERY_REQUEST : 발송 요청 = 주문완료<br>' +
      '  DELIVERY_CONFIRMED : 발송 대기 = 발송 확정<br>' +
      '  DELIVERY_COMPLETE : 발송 완료<br>' +
      '  DELIVERY_CANCEL : 발송 취소`',
  })
  // ===================================
  @IsOptional()
  @IsEnum(IOrderStatus)
  status?: IOrderStatus;
  @ApiPropertyOptional({
    description:
      '미해결 발송 실패 건 포함 주문만 조회한다. FAIL/FAIL_SMS 이면서 재발송되지 않은(resendAt IS NULL) 활성 발송건이 하나라도 있으면 해당한다.',
    default: false,
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  hasFailedDelivery?: boolean;

  @ApiPropertyOptional({
    description: '기간 검색 기준 ex) REGISTER: 등록일자(기본), SEND: 발송일자(actual_send_at)',
    enum: IOrderDateType,
    default: IOrderDateType.REGISTER,
  })
  // ===================================
  @IsOptional()
  @IsEnum(IOrderDateType)
  dateType?: IOrderDateType = IOrderDateType.REGISTER;

  @ApiPropertyOptional({
    description: '기간 조회 시작 날짜 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // ===================================
  @IsOptional()
  @Matches(dateAtRegexp)
  startAt?: string;

  @ApiPropertyOptional({
    description: '기간 조회 끝 날짜 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // ===================================
  @IsOptional()
  @Matches(dateAtRegexp)
  endAt?: string;

  @ApiPropertyOptional({
    description: '검색조건 ex) ALL: 전체, CUSTOMER: 고객사, MANAGER: 담당자, EVENT: 이벤트명, PRODUCT: 상품명',
    enum: ['ALL', 'CUSTOMER', 'MANAGER', 'OPERATION_ADMIN', 'EVENT', 'PRODUCT'],
    default: 'ALL',
  })
  // ===================================
  @IsOptional()
  @IsEnum(['ALL', 'CUSTOMER', 'MANAGER', 'OPERATION_ADMIN', 'EVENT', 'PRODUCT'])
  searchType?: 'ALL' | 'CUSTOMER' | 'MANAGER' | 'OPERATION_ADMIN' | 'EVENT' | 'PRODUCT' = 'ALL';

  @ApiPropertyOptional({
    description: '검색어 (최소 1자)',
  })
  // ===================================
  @IsOptional()
  searchKeyword?: string;

  @ApiPropertyOptional({
    description: '발송 유형 필터 ex) ALL: 전체, DIRECT: 직발송, AGENCY: 대행발송',
    enum: IOrderSendingType,
    default: IOrderSendingType.ALL,
  })
  // ===================================
  @IsOptional()
  @IsEnum(IOrderSendingType)
  sendingType?: IOrderSendingType = IOrderSendingType.ALL;
}

export class OrderGetListSummaryReqDto extends PickType(OrderGetListReqDto, [
  'section',
  'type',
  'dateType',
  'startAt',
  'endAt',
  'searchType',
  'searchKeyword',
  'sendingType',
] as const) {
  @ApiProperty({
    description: '발송관리 집계만 지원합니다.',
    enum: [IOrderSection.SHIPPING],
    default: IOrderSection.SHIPPING,
  })
  @IsIn([IOrderSection.SHIPPING])
  section: IOrderSection = IOrderSection.SHIPPING;
}

/**
 * 발송관리 고객사 정산정보(호버 툴팁) 조회 요청.
 * 목록 응답과 분리된 지연 로딩 전용이라 현재 페이지의 주문 id 만 콤마로 전달한다.
 * type 은 목록(/order/list)과 동일한 발송관리 세부권한(SEND_GENERAL / SEND_SSG) 검증에 쓰인다.
 */
export class OrderGetCustomerSettlementReqDto {
  @ApiProperty({
    description: '주문 id 목록 (콤마 구분, 최대 200개) ex) 101,102,103',
  })
  // ===================================
  @Transform(({ value }) =>
    String(value ?? '')
      .split(',')
      .map((raw) => Number(raw.trim()))
      .filter((id) => Number.isInteger(id) && id > 0),
  )
  @IsArray()
  @ArrayMaxSize(200)
  @IsInt({ each: true })
  ids: number[];

  @ApiProperty({
    description: '발송관리 화면 구분 ex) 일반발송: GENERAL, 신세계발송: SSG',
    enum: [IOrderType.GENERAL, IOrderType.SSG],
  })
  // ===================================
  @IsIn([IOrderType.GENERAL, IOrderType.SSG])
  type: IOrderType.GENERAL | IOrderType.SSG;
}

export class OrderCreateTempReqDto extends OrderCreateDto {
  @ApiProperty({
    description: '주문 타입 ex) 일반: GENERAL, 신세계: SSG, 맞춤형: CUSTOM',
    default: 'GENERAL',
  })
  // ==============================================
  @IsEnum(IOrderType)
  type: IOrderType;
}

export class OrderGetDetailReqParamDto {
  @ApiProperty({
    description: 'order id',
  })
  // ==============================================
  @IsNumber()
  @IsNotEmpty()
  @Type(() => Number)
  id: number;
}

export class OrderGetDeliveryCompleteReportReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ==============================================
  @IsNumber()
  @Type(() => Number)
  id: number;

  @ApiPropertyOptional({
    description: '수신정보 마스킹 해제 (SUPER_ADMIN/OPERATION_ADMIN만 허용)',
    default: false,
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  unmasked?: boolean;
}

export class OrderGetDeliveryCompleteReportPdfReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ==============================================
  @IsNumber()
  @IsNotEmpty()
  id: number;

  @ApiProperty({
    description: '발행 소스 (DOCUMENT: 문서함 다운로드, DIRECT: 직접발행). 미전송 시 DOCUMENT 로 기록된다.',
    enum: [IReportSource.DOCUMENT, IReportSource.DIRECT],
    required: false,
  })
  @IsOptional()
  // @IsOptional() 은 null/undefined 만 건너뛰고 빈 문자열은 검증한다. 정규화 없이 @IsEnum 을 붙이면
  // source:'' 를 보내던 기존 클라이언트가 400 을 받는다 — 종전에는 통과 후 DOCUMENT 로 저장됐다.
  // 빈 값은 '미전송'과 같은 뜻이므로 undefined 로 접어 기존 계약을 보존한다.
  @Transform(({ value }) => (value === '' ? undefined : value))
  // 정산 목록의 발행 상태 문구가 이 값으로 분기하므로(settle.service.formatReportStatus) 자유 문자열을
  // 허용하면 오타가 조용히 '다운로드 완료'로 폴백한다. EMAIL 이 목록에서 빠진 이유는 상수 주석 참고.
  @IsEnum(CLIENT_SETTABLE_REPORT_SOURCES)
  source?: string;

  @ApiPropertyOptional({
    description: '수신정보 마스킹 해제 여부 (감사 로그 기록용)',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  unmasked?: boolean;
}

export class OrderGetOrderCompleteReportReqDto extends OrderGetDeliveryCompleteReportReqDto {}

export class OrderGetOrderCompleteReportPdfReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ==============================================
  @IsNumber()
  @IsNotEmpty()
  id: number;

  @ApiProperty({
    description: '발행 소스 (DOCUMENT: 문서함 다운로드, DIRECT: 직접발행). 미전송 시 DOCUMENT 로 기록된다.',
    enum: [IReportSource.DOCUMENT, IReportSource.DIRECT],
    required: false,
  })
  @IsOptional()
  // @IsOptional() 은 null/undefined 만 건너뛰고 빈 문자열은 검증한다. 정규화 없이 @IsEnum 을 붙이면
  // source:'' 를 보내던 기존 클라이언트가 400 을 받는다 — 종전에는 통과 후 DOCUMENT 로 저장됐다.
  // 빈 값은 '미전송'과 같은 뜻이므로 undefined 로 접어 기존 계약을 보존한다.
  @Transform(({ value }) => (value === '' ? undefined : value))
  // 정산 목록의 발행 상태 문구가 이 값으로 분기하므로(settle.service.formatReportStatus) 자유 문자열을
  // 허용하면 오타가 조용히 '다운로드 완료'로 폴백한다. EMAIL 이 목록에서 빠진 이유는 상수 주석 참고.
  @IsEnum(CLIENT_SETTABLE_REPORT_SOURCES)
  source?: string;
}

export class OrderGetDestructionCertificatePdfReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ==============================================
  @IsNumber()
  @IsNotEmpty()
  id: number;
}

export class OrderGetSettleReqDto extends PagingReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ==============================================
  @IsNumber()
  @IsNotEmpty()
  @Type(() => Number)
  id: number;
}

export class OrderCreateSettleReqDto {
  @ApiProperty({
    description: '정산 정보 입력 목록 list',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderSettleCreateDto)
  // =============================
  list: OrderSettleCreateDto[];

  @ApiProperty({
    description: '카드할증 적용 여부',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  cardSurchargeApplied?: boolean;

  @ApiProperty({
    description:
      '결제수단 (주문 단위) CARD|CASH. cardSurchargeApplied 와 독립 저장(강제 결합 없음). 미전송 시 정책값(WALLET=wallet_account.settleMethod / LEGACY=company.settleMethod)으로 폴백',
    required: false,
  })
  @IsOptional()
  @IsIn(['CARD', 'CASH'])
  settleMethod?: 'CARD' | 'CASH';
}

export class OrderUpdateSettleReqDto extends OrderCreateSettleReqDto {}

export class OrderUpdateTempReqDto extends OrderCreateDto {
  @ApiProperty({
    description: 'order id',
  })
  // =============================
  @IsNumber()
  @IsNotEmpty()
  id: number;
}

export class OrderDeleteTempReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // =============================
  @IsNumber()
  @IsNotEmpty()
  id: number;
}

export class OrderDeliveryRequestReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ==================================
  @IsNotEmpty()
  @IsNumber()
  id: number;
}

export class OrderDeliveryConfirmedReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ==================================
  @IsNotEmpty()
  @IsNumber()
  id: number;

  // 신용초과는 사용자 재시도가 아니라 운영자 승인 → 서버 발송확정으로 처리한다.
  // (forceConfirm / creditExcessApprovalId 재제출 계약 제거)

  // ===== Wallet PR3: 운영자 사용액 입력 (WALLET 모드 분배 반영) =====
  @ApiPropertyOptional({
    description: '포인트 사용 요청액. 미입력 시 0(포인트 미사용). 사용 가능 포인트(ALLOW 합) 초과 시 400.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  pointUseAmount?: number;

  @ApiPropertyOptional({
    description: '후정산 고객사 예치금 사용 토글. 선정산은 무시(항상 자동 사용).',
  })
  @IsOptional()
  @IsBoolean()
  depositUseEnabled?: boolean;

  @ApiPropertyOptional({
    description: '후정산 고객사 예치금 사용 요청액. 예치금 잔액 초과 시 400.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  depositUseAmount?: number;
}

export class OrderAllocationPreviewReqDto {
  @ApiProperty({ description: 'order id' })
  @IsNotEmpty()
  @IsNumber()
  id: number;

  @ApiPropertyOptional({ description: '포인트 사용 요청액 (미입력 시 0). 사용 가능 포인트 초과 시 400.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  pointUseAmount?: number;

  @ApiPropertyOptional({ description: '후정산 고객사 예치금 사용 토글. 선정산은 무시.' })
  @IsOptional()
  @IsBoolean()
  depositUseEnabled?: boolean;

  @ApiPropertyOptional({ description: '후정산 고객사 예치금 사용 요청액. 예치금 잔액 초과 시 400.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  depositUseAmount?: number;
}

export class OrderReviewCompleteReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ==================================
  @IsNotEmpty()
  @IsNumber()
  id: number;
}

export class OrderDeliverySsgCouponExpireChangeReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ==================================
  @IsNotEmpty()
  @IsNumber()
  id: number;

  @ApiProperty({
    description: '신세계 상품 유효 기간',
  })
  // ==================================
  @IsNotEmpty()
  @IsNumber()
  @IsIn([60, 90, 180])
  couponExpiration: number;
}

export class OrderDeliveryCancelReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ==================================
  @IsNotEmpty()
  @IsNumber()
  id: number;

  @ApiProperty({
    description: '주문 취소 사유',
  })
  // ==================================
  @IsNotEmpty()
  @IsString()
  @MaxLength(1000)
  cancelReason: string;
}

export class OrderUpdateOperationUserReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ==================================
  @IsNotEmpty()
  @IsNumber()
  id: number;

  @ApiProperty({
    description: '운영 담당자 지정 user id',
  })
  // ==================================
  @IsNotEmpty()
  @IsNumber()
  operationUserId: number;
}

export class OrderExcelDownloadReqBodyDto {
  @ApiPropertyOptional({
    description: '구분 ex) 주문관리 : ORDER, 발송관리: SHIPPING',
    default: IOrderSection.ORDER,
  })
  // ==============================================
  @IsEnum(IOrderSection)
  section: IOrderSection = IOrderSection.ORDER;

  @ApiProperty({
    description: '주문 타입 ex) 일반: GENERAL, 신세계: SSG',
    default: 'GENERAL',
  })
  // ==============================================
  @IsEnum(IOrderType)
  type: IOrderType = IOrderType.GENERAL;

  @ApiPropertyOptional({
    description:
      '발송 상태 <br>' +
      'TEMP : 임시 저장<br>' +
      '  DELIVERY_REQUEST : 발송 요청 = 주문완료<br>' +
      '  DELIVERY_CONFIRMED : 발송 대기 = 발송 확정<br>' +
      '  DELIVERY_COMPLETE : 발송 완료<br>' +
      '  DELIVERY_CANCEL : 발송 취소`',
  })
  // ===================================
  @IsOptional()
  @IsEnum(IOrderStatus)
  status?: IOrderStatus;

  @ApiPropertyOptional({
    description: '기간 검색 기준 ex) REGISTER: 등록일자(기본), SEND: 발송일자(actual_send_at)',
    enum: IOrderDateType,
    default: IOrderDateType.REGISTER,
  })
  // ===================================
  @IsOptional()
  @IsEnum(IOrderDateType)
  dateType?: IOrderDateType = IOrderDateType.REGISTER;

  @ApiPropertyOptional({
    description: '기간 조회 시작 날짜 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // ===================================
  @IsOptional()
  @Matches(dateAtRegexp)
  startAt?: string;

  @ApiPropertyOptional({
    description: '기간 조회 끝 날짜 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // ===================================
  @IsOptional()
  @Matches(dateAtRegexp)
  endAt?: string;

  @ApiPropertyOptional({
    description: '검색조건 ex) ALL: 전체, CUSTOMER: 고객사, MANAGER: 담당자, EVENT: 이벤트명, PRODUCT: 상품명',
    enum: ['ALL', 'CUSTOMER', 'MANAGER', 'EVENT', 'PRODUCT'],
    default: 'ALL',
  })
  // ===================================
  @IsOptional()
  @IsEnum(['ALL', 'CUSTOMER', 'MANAGER', 'EVENT', 'PRODUCT'])
  searchType?: 'ALL' | 'CUSTOMER' | 'MANAGER' | 'EVENT' | 'PRODUCT' = 'ALL';

  @ApiPropertyOptional({
    description: '검색어 (최소 1자)',
  })
  // ===================================
  @IsOptional()
  searchKeyword?: string;

  @ApiPropertyOptional({
    description: '발송 유형 필터 ex) ALL: 전체, DIRECT: 직발송, AGENCY: 대행발송',
    enum: IOrderSendingType,
    default: IOrderSendingType.ALL,
  })
  // ===================================
  @IsOptional()
  @IsEnum(IOrderSendingType)
  sendingType?: IOrderSendingType = IOrderSendingType.ALL;

  @ApiProperty({
    description: '비밀번호 (다운로드 확인용)',
  })
  // ===================================
  @IsNotEmpty()
  password: string;

  @ApiProperty({
    description: '다운로드 사유',
  })
  // ===================================
  @IsNotEmpty()
  downloadReason: string;
}

export class OrderTestDeliveryReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ===================================
  @IsNumber()
  @IsNotEmpty()
  orderId: number;

  @ApiProperty({
    description: 'order product mapping id',
  })
  // ===================================
  @IsNumber()
  @IsNotEmpty()
  orderProductMappingId: number;

  @ApiProperty({
    description: '수신 대상',
  })
  // ===================================
  @IsNotEmpty()
  deliveryTarget: string;
}

export class OrderGetPreviousContentReqQueryDto {
  @ApiProperty({
    description: 'order id',
  })
  // ===================================
  @IsNumber()
  @IsNotEmpty()
  @Type(() => Number)
  orderId: number;

  @ApiProperty({
    description: 'product id',
  })
  // ===================================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  productId?: number;
}

export class OrderUpdateEncourageDayReqParamDto {
  @ApiProperty({
    description: 'order_product_mapping id (상품별 설정)',
  })
  // ===================================
  @IsNumber()
  @IsNotEmpty()
  @Type(() => Number)
  id: number;
}

export class OrderUpdateEncourageDayReqBodyDto {
  @ApiProperty({
    description: '독려 문자 day (1 이상의 정수, null이면 미사용)',
    nullable: true,
  })
  // ===================================
  @IsDefined()
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(1)
  encourageDay: number | null;
}

export class OrderUpdateGalaxiaDurationReqParamDto {
  @ApiProperty({
    description: 'order_product_mapping id (상품별 설정)',
  })
  // ===================================
  @IsNumber()
  @IsNotEmpty()
  @Type(() => Number)
  id: number;
}

export class OrderUpdateGalaxiaDurationReqBodyDto {
  @ApiPropertyOptional({
    description: 'GALAXIA cpn 유효기간 일수 (1~999, null이면 미사용)',
  })
  // ===================================
  @IsOptional()
  @IsNumber()
  galaxiaDuration: number | null;
}

export class OrderUpdateTailTextReqParamDto {
  @ApiProperty({
    description: 'order_product_mapping id (상품별 설정)',
  })
  // ===================================
  @IsNumber()
  @IsNotEmpty()
  @Type(() => Number)
  id: number;
}

export class OrderUpdateTailTextReqBodyDto {
  @ApiPropertyOptional({
    description: '꼬리 광고 text (null 또는 빈 문자열이면 미사용)',
  })
  // ===================================
  @IsOptional()
  @IsString()
  @MaxLength(100)
  sendTailText: string | null;
}

export class OrderUpdateUseEmailContentReqParamDto {
  @ApiProperty({
    description: 'order_product_mapping id (상품별 설정)',
  })
  // ===================================
  @IsNumber()
  @IsNotEmpty()
  @Type(() => Number)
  id: number;
}

export class OrderUpdateUseEmailContentReqBodyDto {
  @ApiProperty({
    description: '이메일 사용방법',
  })
  // ===================================
  @IsNotEmpty()
  @IsString()
  useEmailContent: string;
}

export class OrderGetReportHistoryReqQueryDto {
  @ApiProperty({
    description:
      '리포트 타입 ex) DELIVERY_COMPLETE_REPORT: 발송완료리포트, TRANSACTION_STATEMENT: 거래명세서, ' +
      'DESTRUCTION_CERTIFICATE: 파기확약서 PDF 발행, DELIVERY_COMPLETE_REPORT_EMAIL: 발송완료리포트 이메일 발송, ' +
      'TRANSACTION_STATEMENT_EMAIL: 거래명세서 이메일 발송, DESTRUCTION_CERTIFICATE_EMAIL: 파기확약서 이메일 발송',
    enum: REPORT_HISTORY_TYPES,
  })
  // ===================================
  @IsNotEmpty()
  // 미검증 문자열은 조회 서비스의 actionType 매핑을 인덱싱한다. 목록 밖 값이 들어오면
  // 200 + 빈 결과로 조용히 폴백해, 실제로 발행된 주문에 "이력 없음"이 뜬다 —
  // 프론트 오타를 배포 후에도 아무도 모른다. 400 으로 즉시 드러낸다.
  @IsIn(REPORT_HISTORY_TYPES as readonly string[])
  reportType: IReportHistoryType;
}

export class OrderGetReportHistoryReqParamDto {
  @ApiProperty({
    description: 'order id',
  })
  // ===================================
  @IsNumber()
  @IsNotEmpty()
  @Type(() => Number)
  orderId: number;
}

export class OrderDeliveryCompleteReportEmailReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ===================================
  @IsNumber()
  @IsNotEmpty()
  orderId: number;

  @ApiProperty({
    description: '수신 이메일',
  })
  // ===================================
  @IsNotEmpty()
  @IsString()
  to: string;

  @ApiProperty({
    description: '이메일 제목',
  })
  // ===================================
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  subject: string;

  @ApiProperty({
    description: '이메일 내용 (HTML)',
  })
  // ===================================
  @IsNotEmpty()
  @IsString()
  content: string;

  @ApiProperty({
    description: 'PDF 파일 (base64 인코딩)',
  })
  // ===================================
  @IsNotEmpty()
  @IsString()
  pdfBase64: string;

  @ApiProperty({
    description: 'PDF 파일명',
  })
  // ===================================
  @IsNotEmpty()
  @IsString()
  pdfFileName: string;

  @ApiPropertyOptional({
    description: '회사 타입 ex) ENMAD: 모바일이앤엠애드, SYSCUSS: 시스커스',
    enum: CompanyType,
    default: CompanyType.ENMAD,
  })
  // ===================================
  @IsOptional()
  @IsEnum(CompanyType)
  companyType?: CompanyType = CompanyType.ENMAD;
}

export class OrderTransactionStatementEmailReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ===================================
  @IsNumber()
  @IsNotEmpty()
  orderId: number;

  @ApiProperty({
    description: '수신 이메일',
  })
  // ===================================
  @IsNotEmpty()
  @IsString()
  to: string;

  @ApiProperty({
    description: '이메일 제목',
  })
  // ===================================
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  subject: string;

  @ApiProperty({
    description: '이메일 내용 (HTML)',
  })
  // ===================================
  @IsNotEmpty()
  @IsString()
  content: string;

  @ApiProperty({
    description: 'PDF 파일 (base64 인코딩)',
  })
  // ===================================
  @IsNotEmpty()
  @IsString()
  pdfBase64: string;

  @ApiProperty({
    description: 'PDF 파일명',
  })
  // ===================================
  @IsNotEmpty()
  @IsString()
  pdfFileName: string;

  @ApiPropertyOptional({
    description: '회사 타입 ex) ENMAD: 모바일이앤엠애드, SYSCUSS: 시스커스',
    enum: CompanyType,
    default: CompanyType.ENMAD,
  })
  // ===================================
  @IsOptional()
  @IsEnum(CompanyType)
  companyType?: CompanyType = CompanyType.ENMAD;
}

export class OrderDestructionCertificateEmailReqDto {
  @ApiProperty({
    description: 'order id',
  })
  // ===================================
  @IsNumber()
  @IsNotEmpty()
  orderId: number;

  @ApiProperty({
    description: '수신 이메일',
  })
  // ===================================
  @IsNotEmpty()
  @IsString()
  to: string;

  @ApiProperty({
    description: '이메일 제목',
  })
  // ===================================
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  subject: string;

  @ApiProperty({
    description: '이메일 내용 (HTML)',
  })
  // ===================================
  @IsNotEmpty()
  @IsString()
  content: string;

  @ApiProperty({
    description: 'PDF 파일 (base64 인코딩)',
  })
  // ===================================
  @IsNotEmpty()
  @IsString()
  pdfBase64: string;

  @ApiProperty({
    description: 'PDF 파일명',
  })
  // ===================================
  @IsNotEmpty()
  @IsString()
  pdfFileName: string;

  @ApiPropertyOptional({
    description: '회사 타입 ex) ENMAD: 모바일이앤엠애드, SYSCUSS: 시스커스',
    enum: CompanyType,
    default: CompanyType.ENMAD,
  })
  // ===================================
  @IsOptional()
  @IsEnum(CompanyType)
  companyType?: CompanyType = CompanyType.ENMAD;
}
