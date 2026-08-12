import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { UserManagementService } from '../../user_management/application/user.management.service';
import { SsgEventService } from '../../ssg_event/application/ssg.event.service';
import { SsgBalanceCheckView, toSsgBalanceCheckView } from '../../ssg_event/application/ssg.balance.guard';
import {
  OrderCreateSettleReqDto,
  OrderCreateTempReqDto,
  OrderDeleteTempReqDto,
  OrderDeliveryCancelReqDto,
  OrderDeliveryConfirmedReqDto,
  OrderDeliveryRequestReqDto,
  OrderDeliverySsgCouponExpireChangeReqDto,
  OrderExcelDownloadReqBodyDto,
  OrderGetDeliveryCompleteReportPdfReqDto,
  OrderGetDeliveryCompleteReportReqDto,
  OrderGetDestructionCertificatePdfReqDto,
  OrderGetDetailReqParamDto,
  OrderGetListReqDto,
  OrderGetOrderCompleteReportPdfReqDto,
  OrderGetOrderCompleteReportReqDto,
  OrderGetPreviousContentReqQueryDto,
  OrderGetSettleReqDto,
  OrderReviewCompleteReqDto,
  OrderTestDeliveryReqDto,
  OrderUpdateOperationUserReqDto,
  OrderUpdateSettleReqDto,
  OrderUpdateTempReqDto,
  OrderUpdateEncourageDayReqBodyDto,
  OrderUpdateGalaxiaDurationReqBodyDto,
  OrderUpdateTailTextReqBodyDto,
  OrderUpdateUseEmailContentReqBodyDto,
  OrderTransactionStatementEmailReqDto,
  OrderDestructionCertificateEmailReqDto,
  OrderAllocationPreviewReqDto,
  OrderGetCustomerSettlementReqDto,
} from '../api/order.req.dto';
import {
  OrderCreateTempResDto,
  OrderDeliveryConfirmed,
  OrderDeliveryAuditDailyDto,
  OrderDeliveryAuditDuplicateDto,
  OrderDeliveryAuditSummaryDto,
  OrderDeliverySsgDuplicateDto,
  OrderGetDeliveryAuditResDto,
  OrderGetDeliveryCompleteReportResDto,
  OrderGetDetailResDto,
  OrderGetListResDto,
  OrderGetMyOrderHistoryResDto,
  OrderGetOrderCompleteReportResDto,
  OrderGetPreviousContentResDto,
  OrderGetSettleGetListResDto,
  OrderAllocationPreviewResDto,
  OrderGetCustomerSettlementResDto,
  OrderPartialDeliveryCancelResDto,
} from '../api/order.res.dto';
import { OrderEntity } from '../../entity/order.entity';
import { InjectRepository } from '@nestjs/typeorm';
import {
  EntityManager,
  In,
  IsNull,
  LessThanOrEqual,
  MoreThanOrEqual,
  Not,
  ObjectLiteral,
  QueryRunner,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { QueryBuilderDateCondition } from '../../common/infra/query.builder.date.condition';
import { CustomerSettlementViewDto, OrderViewDto } from '../api/dto/order.view.dto';
import { DateDateFormatStr, DateFormatStr } from '../../common/domain/date.format.str';
import { format } from 'date-fns';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { IOrderStatus } from '../interface/order.status';
import { IOrderSendMethod } from '../interface/order.send.method';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { IsolationLevel, Propagation, Transactional, runOnTransactionCommit } from 'typeorm-transactional';
import { OrderCancelNotificationService } from './order.cancel.notification.service';
import { isDirectCustomerCancelTarget } from '../domain/order.cancel.notification.policy';
import {
  resolveDestructionCertificateGate,
  destructionCertificateBlockMessage,
} from '../domain/destruction.certificate.gate';
import {
  KIND_CERTAINTY,
  EffectiveDestroyAtKind,
  resolveOrderEffectiveDestroyAt,
} from '../domain/effective.destroy.date';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { TestOrderDeliveryEntity } from '../../entity/test.order.delivery.entity';
import { ProductEntity } from '../../entity/product.entity';
import {
  OrderValidation,
  validateSsgReservationWindow,
  validateSsgUniformSend,
  validateDeliverySendTypes,
  resolveProductDuplicateLimit,
  assertWalletOnlyParamsAbsent,
  assertSettleListDeliveryCoverage,
} from '../domain/order.validation';
import { OrderFromService } from '../../order_from/application/order.from.service';
import { getBillingUserId } from '../domain/order.billing-user.helper';
import {
  DELIVERY_CANCEL_CUTOFF_MS,
  DeliveryCancelBlockReason,
  evaluateDeliveryCancelable,
} from '../domain/delivery.cancelable';
import { listToMap, listToMapValue } from '../../util/map.util';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { NOT_CUTOVER_ORDER_DELIVERY } from '../../delivery/interface/legacy.delivery.entry.point';
import {
  MUTATION_CLAIM_STALE_MS,
  UNSENDABLE_COUPON_STATUSES,
} from '../../delivery/interface/order.delivery.mutation.claim';
import { CreateTransactionId } from '../domain/create.transaction.id';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { DeliveryCreateCouponImage } from '../../delivery/infra/delivery.create.coupon.image';
import { createExportTempPath } from '../../util/file.util';
import { UserEntity } from '../../entity/user.entity';
import { UserCompanyEntity } from '../../entity/user.company.entity';
import {
  buildPartnerSettleSnapshot,
  buildLineProductSnapshot,
  buildClientAssignmentTransition,
  buildOrderClientUserSnapshot,
  buildOrderOperationUserSnapshot,
  buildOrderUserSnapshot,
  buildPriceDivergence,
  readBillingView,
  readClientUserView,
  readLineProductView,
  readOperationPersonName,
} from '../util/order.snapshot.builder';
import {
  assertLineIdsValid,
  OwnedLine,
  resolveCarriedLineId,
  resolveLineSnapshot,
  resolvePartnerSettleSnapshot as resolvePartnerSettleSnapshotForUpdate,
} from './order.snapshot.update.helper';
import { UserViewScopeEntity, ViewScopeType } from '../../entity/user.view.scope.entity';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserSettleCondition } from '../../user/interface/user.settle.condition';
import { IOrderSection } from '../interface/order.section';
import {
  OrderCompleteReportDeliveryViewDto,
  OrderDeliveryCompleteReportViewDto,
  OrderDetailProductDto,
  OrderTestDeliveryHistoryDto,
  OrderPdfDetailProductDto,
  OrderViewDeliveryDto,
} from '../api/dto/order.detail.product.dto';
import { normalizeDate } from '../../util/time.util';
import * as process from 'node:process';
import { createHash } from 'crypto';
import * as ExcelJS from 'exceljs';
import { OrderSettleViewDto } from '../api/dto/order.settle.view.dto';
import { UserDiscountEntity } from '../../entity/user.discount.entity';
import { findMatchingDiscount } from '../../user_discount/domain/discount.matcher';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { IOrderType } from '../interface/order.type';
import { IOrderSettleDiscountType } from '../interface/order.settle.discount.type';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { SsgEventAmountHistoryEntity } from '../../entity/ssg.event.amount.history.entity';
import { IProductType } from '../../product/interface/product.type';
import { defaultOrderMidImagePath, defaultOrderTopImagePath } from '../../const';
import { OrderStatusExcelMapping } from '../domain/order.excel.mapping';
import { OrderFeeCalculator, applyCardSurcharge } from '../domain/order.fee.calculator';
import {
  calculateOrderSettlementAmount,
  buildSettlementDisplayLines,
  notDiscardedReplacedOriginPredicate,
} from '../../util/settle-fee.util';
import { OrderCustomerViewDto } from '../api/dto/order.customer.view.dto';
import { MaskingUtil } from '../../common/utils/masking.util';
import { resolveExpireDays } from '../../common/utils/expire.util';
import { createTempOrderCode, deriveOrderCodeFromId } from '../domain/order.code';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { PhoneUtil } from '../../common/utils/phone.util';
import { DeliveryBatchService } from '../../delivery/application/delivery.batch.service';
import { IOrderSendingType } from '../interface/order.sending.type';
import {
  canTransitionDelivery,
  shouldExposeSsgBalanceCheck,
} from '../domain/order.delivery-transition-authority.helper';
import { IOrderDateType } from '../interface/order.date.type';
import { IReportSource } from '../interface/report.source';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ActivityLogResult } from '../../activity_log/interface/activity.log.result';
import {
  buildSettleDiscountChanges,
  buildSettleDeliveryChanges,
  isSettleOrderChanged,
  SETTLE_DISCOUNT_SOURCE_ACTION_TYPE,
  SettleDeliveryChange,
  SettleDeliverySnapshot,
  SettleDiscountChange,
  SettleDiscountChangeSource,
  SettleFieldSnapshot,
  SettleSnapshot,
  SettleOrderSnapshot,
} from '../domain/settle.discount.history';
import { WalletCutoverConfig, WalletCutoverMode } from '../../wallet/config/wallet-cutover.config';
import { WalletManagedPredicate } from '../../wallet/application/wallet-managed.predicate';
import { SettlementCodeRequiredError } from '../../wallet/application/settlement-code-required.error';
import { WalletAccountResolverService } from '../../wallet/application/wallet-account-resolver.service';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import {
  AllocationInput,
  AllocationResult,
  PaymentAllocationService,
} from '../../wallet/application/payment-allocation.service';
import { WalletAllocationInputBuilder } from '../../wallet/application/wallet-allocation-input.builder';
import { ForbiddenWordMatcher } from '../../forbidden_word/application/forbidden.word.matcher';
import { ForbiddenWordBlockLogEntity } from '../../entity/forbidden.word.block.log.entity';
import { OrderProductCreateTempDto } from '../api/dto/order.product.create.temp.dto';
import { OrderConfirmationWalletService } from '../../wallet/application/order-confirmation-wallet.service';
import { CreditExcessApprovalService } from '../../wallet/application/credit-excess-approval.service';
import { CreditExcessApprovalDriftError } from '../../wallet/application/credit-excess-approval.errors';
import { buildCreditExcessSnapshot, CreditExcessSnapshot, diffCreditExcessSnapshot } from './credit-excess-snapshot';
import { CreditExcessApprovalExecutionContext } from './credit-excess-approval.context';
import { OrderConfirmationReleaseService } from '../../wallet/application/order-confirmation-release.service';
import { RefundPoolService } from '../../wallet/application/refund-pool.service';
import { OrderPaymentRefundEventType } from '../../entity/order.payment.refund.event.entity';
import { LegacyWalletCreditSyncService } from '../../wallet/application/legacy-wallet-credit-sync.service';
import { ShadowMismatchClassifierService } from '../../wallet/application/shadow-mismatch-classifier.service';
import { BillingScopeLockService } from '../../wallet/application/billing-scope-lock.service';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { MailSendSmtp } from '../../mail/infrastructure/mail-send.smtp';
import { CompanyType, INTERNAL_BUSINESS_NUMBERS } from '../../common/domain/company.type';
import { OrderDeliveryCompleteReportEmailReqDto } from '../api/order.req.dto';
import { EmailSendHistoryEntity } from '../../entity/email.send.history.entity';
import { OrderManualEntryEntity } from '../../entity/order.manual.entry.entity';
import { ManualEntryItemDto, ManualEntryViewDto } from '../api/dto/order.manual.entry.dto';

dayjs.extend(utc);

dayjs.extend(timezone);

/**
 * SSG 가상 행에서 저장값 우선, 없으면 UserDiscount 폴백
 * 우선순위: delivery 저장값 → mapping 저장값 → findMatchingDiscount
 */
function resolveSettleFee(
  firstDelivery: {
    settleFee: number | null;
    settlePriceAdjustment: IPriceAdjustment | null;
    settleDiscountType: IOrderSettleDiscountType | null;
  },
  mapping: {
    fee: number | null;
    priceAdjustment: IPriceAdjustment | null;
    settleDiscountType: IOrderSettleDiscountType | null;
  },
  isOrderCompleted: boolean,
  computeMatchingDiscount: () => ReturnType<typeof findMatchingDiscount>,
): { fee: number; priceAdjustment: IPriceAdjustment | null; settleDiscountType: IOrderSettleDiscountType | null } {
  // 1. delivery 저장값 (deliveryIds 포함 저장 시)
  if (firstDelivery.settleFee != null && firstDelivery.settlePriceAdjustment != null) {
    return {
      fee: firstDelivery.settleFee,
      priceAdjustment: firstDelivery.settlePriceAdjustment,
      settleDiscountType: firstDelivery.settleDiscountType ?? mapping.settleDiscountType,
    };
  }
  // 2. mapping 저장값 (deliveryIds 미포함 저장 시)
  if (mapping.fee != null && mapping.priceAdjustment != null) {
    return {
      fee: mapping.fee,
      priceAdjustment: mapping.priceAdjustment,
      settleDiscountType: mapping.settleDiscountType,
    };
  }
  // 3. UserDiscount 폴백 (미저장 상태)
  if (!isOrderCompleted) {
    const matchingDiscount = computeMatchingDiscount();
    return {
      fee: matchingDiscount?.pricePercent ?? 0,
      priceAdjustment: matchingDiscount?.priceAdjustment ?? null,
      settleDiscountType: mapping.settleDiscountType,
    };
  }
  return { fee: 0, priceAdjustment: null, settleDiscountType: mapping.settleDiscountType };
}

/**
 * 발송완료리포트 행에 넣을 발송건인지 판정한다(197-16 예약건 부분취소).
 *
 * 취소(발송취소)된 건은 발송되지 않았고 그 몫은 이미 환불됐으므로 "발송완료 리포트" 의 행이 아니다.
 * 실패(FAIL)건은 제외하지 않는다 — 재발송으로 되살아날 수 있고, 발급 후 발송만 실패한 경우에는
 * 바코드가 살아 있어 고객이 확인해야 할 정보다(markSendFail 은 status/failedAt 만 바꾸고 barCode 유지).
 *
 * getDeliveryCompleteReport / getDeliveryCompleteReportMultiple 두 리포트 루프가 공유한다.
 * (spec: order.service.report-cancel-exclusion.spec.ts 가 이 술어를 직접 검증한다.)
 */
export function isDeliveryInCompleteReport(delivery: Pick<OrderDeliveryEntity, 'status'>): boolean {
  return delivery.status !== IOrderDeliveryStatus.CANCEL;
}

/**
 * 거래명세서(단건/다중 공통) 품목 행 구성.
 *
 * D3-49 리뷰 B안: 차등정산(SSG 중복할인) 매핑은 요율 적용 단가별로 행을 분리한다(상세 화면과 동일 구성).
 * 모든 행의 단가가 실존값이라 unitPrice * quantity === price 가 항상 성립한다(평균단가 근사 제거).
 * 균일 요율 매핑은 기존처럼 단일 행이며, 분리된 행들은 같은 매핑 id 를 공유한다.
 * 행별 일자(sendRequestAt)는 단건/다중(증빙일자)의 규칙이 달라 호출부에서 계산해 넘긴다.
 */
function buildOrderCompleteReportRows(
  mapping: OrderProductMappingEntity,
  sendRequestAt: string | null,
): OrderCompleteReportDeliveryViewDto[] {
  const lineView = readLineProductView(mapping);

  return buildSettlementDisplayLines(mapping).map((line) => ({
    id: mapping.id, // orderProductMapping id 사용
    sendRequestAt,
    productName: lineView.name,
    quantity: line.amount, // 수량
    unitPrice: line.price, // 할인/할증 적용된 실제 단가(행 내 균일)
    price: line.price * line.amount, // 공급가액 (단가 * 수량)
  }));
}

type OrderSearchType = 'ALL' | 'CUSTOMER' | 'MANAGER' | 'OPERATION_ADMIN' | 'EVENT' | 'PRODUCT';

type OrderListQueryParams = {
  section: IOrderSection;
  type: IOrderType;
  status?: IOrderStatus;
  hasFailedDelivery?: boolean;
  startAt?: string;
  endAt?: string;
  searchType?: OrderSearchType;
  searchKeyword?: string;
  sendingType?: IOrderSendingType;
  dateType?: IOrderDateType;
};

/**
 * 리포트 1종이 쓰는 발행 카운트 컬럼 쌍.
 *
 * 발송완료리포트와 거래명세서는 컬럼만 다를 뿐 발행 집계 규칙이 같아, 이메일 전송 공통 헬퍼
 * (sendReportEmail)에 이 쌍을 넘겨 어느 리포트의 카운트를 올릴지 지정한다.
 * 파기증명서는 대응 컬럼도, 정산 목록 표시 컬럼도 없으므로 이 값을 넘기지 않는다(카운트 없음).
 *
 * ⚠️ 두 필드를 독립 유니온으로 두면 안 된다. 그러면 2×2=4 조합이 모두 컴파일을 통과해
 * `{ countColumn: 'orderCompleteReportCount', sourceColumn: 'deliveryReportLastSource' }` 같은
 * 교차 쌍(거래명세서를 보냈는데 발송완료리포트의 source 가 덮이는 상태)이 타입 검사를 빠져나간다.
 * 판별 유니온으로 두어 짝이 어긋난 조합을 애초에 표현 불가능하게 만든다.
 */
type ReportCounterColumns =
  | { countColumn: 'deliveryCompleteReportCount'; sourceColumn: 'deliveryReportLastSource' }
  | { countColumn: 'orderCompleteReportCount'; sourceColumn: 'transactionStatementLastSource' };

// 발송 취소 마감(DELIVERY_CANCEL_CUTOFF_MS)은 '../domain/delivery.cancelable' 로 이동했다.
// SQL 게이트(findCancelableDeliveryIds)와 화면 표시 술어(evaluateDeliveryCancelable)가 같은 값을
// 공유하기 위함. 배치 주기와의 관계 등 근거는 그 파일의 상수 주석 참고.

/**
 * 부분취소 거부 응답에 나열할 발송건 id 최대 개수.
 * deliveryIds 상한이 1000 이라 전량을 이어붙이면 에러 메시지 하나가 7KB 를 넘고 화면에도 다 못 띄운다.
 * 사용자에게는 앞부분 + "외 N건" 만 보이고, 전량은 거부 로그(DELIVERY_CANCEL_REJECT)에 남는다.
 */
const NOT_CANCELABLE_IDS_IN_MESSAGE = 20;

/**
 * "되돌릴 수 없는 발송건" 판정 술어. **사전 조회와 실제 UPDATE 가 이 하나를 공유한다.**
 *
 * 나눠 쓰면 안 되는 이유: 사전 조회로 0 건을 확인해도 그건 그 순간의 사진일 뿐이다. 조회와 갱신
 * 사이에 발송 배치가 WAIT 행을 집어 발급·발송을 시작할 수 있고, 갱신이 같은 조건을 다시 보지
 * 않으면 이미 나간 건까지 CANCEL 로 덮고 전액 환불한다(197-16 리뷰 P1). 두 곳이 서로 다른
 * 조건으로 갈리는 것을 막으려면 문장 자체를 하나만 둬야 한다.
 *
 * 하나라도 참이면 되돌릴 수 없다.
 *  - actual_send_at   : 실제로 나갔다
 *  - coupon_issued_at : 쿠폰이 발급됐다(초이스 선택 / 이메일 수령 경로)
 *  - bar_code         : PIN 이 협력사에 발급됐다(일반 배치 경로 — coupon_issued_at 을 안 쓴다)
 *  - claimed_at       : 발송 배치가 소유권을 잡았다. 곧 나가므로 덮으면 안 된다
 *  - status 가 터미널 : COMPLETE / COMPLETE_SMS / FAIL / FAIL_SMS
 *
 * ※ 부정형(`NOT (...)`)으로 써도 안전하다 — 모든 항이 `IS NOT NULL` 이거나 NOT NULL 컬럼의
 *   `IN` 이라 NULL 을 내지 않는다. 세 값 논리로 조건이 조용히 뒤집히지 않는다.
 * ※ status = WAIT 은 **넣지 않는다.** 전체취소는 발송확정 전(발송건이 TEMP)에도 불리므로,
 *   부분취소 CAS 의 조건을 그대로 베끼면 그 주문들이 통째로 취소 불가가 된다.
 *
 * @param prefix SelectQueryBuilder 는 별칭이 필요하고(`'od.'`), UpdateQueryBuilder 는 없다(`''`).
 */
const irreversibleDeliveryPredicate = (prefix = ''): string =>
  `(${prefix}actualSendAt IS NOT NULL OR ${prefix}couponIssuedAt IS NOT NULL ` +
  `OR ${prefix}barCode IS NOT NULL OR ${prefix}claimedAt IS NOT NULL ` +
  `OR ${prefix}status IN (:...terminal))`;

/** 위 술어가 쓰는 바인딩. 목록이 갈리면 두 곳의 판정이 달라지므로 같이 둔다. */
const IRREVERSIBLE_TERMINAL_PARAMS = {
  terminal: [
    IOrderDeliveryStatus.COMPLETE,
    IOrderDeliveryStatus.COMPLETE_SMS,
    IOrderDeliveryStatus.FAIL,
    IOrderDeliveryStatus.FAIL_SMS,
  ],
};

@Injectable()
export class OrderService {
  private logger = new Logger('OrderService');
  // 기본 상단 이미지
  private static readonly DEFAULT_TOP_IMAGE_PATH = defaultOrderTopImagePath;

  // 기본 중간 이미지
  private static readonly DEFAULT_MID_IMAGE_PATH = defaultOrderMidImagePath;

  constructor(
    @InjectRepository(OrderEntity)
    private orderRepository: Repository<OrderEntity>,
    @InjectRepository(OrderProductMappingEntity)
    private orderProductMappingRepository: Repository<OrderProductMappingEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
    @InjectRepository(TestOrderDeliveryEntity)
    private testOrderDeliveryRepository: Repository<TestOrderDeliveryEntity>,
    @InjectRepository(ProductEntity)
    private productRepository: Repository<ProductEntity>,
    @InjectRepository(UserDiscountEntity)
    private userDiscountRepository: Repository<UserDiscountEntity>,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    @InjectRepository(UserCompanyEntity)
    private userCompanyRepository: Repository<UserCompanyEntity>,
    @InjectRepository(SsgEventEntity)
    private ssgEventRepository: Repository<SsgEventEntity>,
    @InjectRepository(SsgEventAmountHistoryEntity)
    private ssgEventAmountHistoryRepository: Repository<SsgEventAmountHistoryEntity>,
    @InjectRepository(UserViewScopeEntity)
    private userViewScopeRepository: Repository<UserViewScopeEntity>,
    private partnerCompanyExternService: PartnerCompanyExternService,
    private readonly userManagementService: UserManagementService,
    private readonly ssgEventService: SsgEventService,
    private readonly cryptoCipher: CryptoCipher,

    private deliveryBatchService: DeliveryBatchService,
    private activityLogService: ActivityLogService,
    private mailSendSmtp: MailSendSmtp,
    @InjectRepository(EmailSendHistoryEntity)
    private emailSendHistoryRepository: Repository<EmailSendHistoryEntity>,
    @InjectRepository(OrderManualEntryEntity)
    private orderManualEntryRepository: Repository<OrderManualEntryEntity>,
    private readonly walletCutoverConfig: WalletCutoverConfig,
    private readonly walletManagedPredicate: WalletManagedPredicate,
    private readonly walletAccountResolverService: WalletAccountResolverService,
    private readonly paymentAllocationService: PaymentAllocationService,
    private readonly orderConfirmationWalletService: OrderConfirmationWalletService,
    private readonly orderConfirmationReleaseService: OrderConfirmationReleaseService,
    private readonly refundPoolService: RefundPoolService,
    private readonly legacyWalletCreditSyncService: LegacyWalletCreditSyncService,
    private readonly shadowMismatchClassifierService: ShadowMismatchClassifierService,
    private readonly walletAllocationInputBuilder: WalletAllocationInputBuilder,
    private readonly forbiddenWordMatcher: ForbiddenWordMatcher,
    private readonly orderCancelNotificationService: OrderCancelNotificationService,
    @InjectRepository(ForbiddenWordBlockLogEntity)
    private readonly forbiddenWordBlockLogRepository: Repository<ForbiddenWordBlockLogEntity>,
    private readonly orderFromService: OrderFromService,
    private readonly billingScopeLockService: BillingScopeLockService,
    @InjectRepository(WalletAccountEntity)
    private readonly walletAccountRepository: Repository<WalletAccountEntity>,
    private readonly creditExcessApprovalService: CreditExcessApprovalService,
  ) {}

  /**
   * 사용액 입력 검증 (clamp 금지). allocate() 의 Math.min 은 초과분을 조용히 잘라내므로
   * 운영자가 모르는 채 확정하는 것을 막기 위해 allocate() 전에 명시 검증한다.
   */
  private assertUsageWithinLimits(
    input: AllocationInput,
    getBody: { pointUseAmount?: number; depositUseAmount?: number; depositUseEnabled?: boolean },
  ): void {
    if (getBody.pointUseAmount != null) {
      const pointAllowable = input.lines
        .filter((l) => l.pointPolicyEffect === 'ALLOW')
        .reduce((s, l) => s + l.grossSettlementAmount, 0);
      if (getBody.pointUseAmount > pointAllowable) {
        throw new BadRequestException('사용 가능 포인트를 초과했습니다.');
      }
    }
    // 예치금: 선정산은 자동 사용(입력 무시) → 검증 안 함. 후정산만 잔액 한도 검증.
    if (!input.isPrePayment && getBody.depositUseAmount != null && getBody.depositUseAmount > input.availableDeposit) {
      throw new BadRequestException('사용 가능 예치금을 초과했습니다.');
    }
  }

  /** 분배 상세 7필드 (요청2 success / 신용초과 응답 공통). null = LEGACY → 0 통일. */
  private allocationDetail(allocation: AllocationResult | null): {
    pointUsedAmount: number;
    depositUsedAmount: number;
    creditUsedAmount: number;
    creditExcessAmount: number;
    cardSurchargeBase: number;
    cardSurchargeAmount: number;
    payableSettlementAmount: number;
  } {
    return {
      pointUsedAmount: allocation?.pointUsedAmount ?? 0,
      depositUsedAmount: allocation?.depositUsedAmount ?? 0,
      creditUsedAmount: allocation?.creditUsedAmount ?? 0,
      creditExcessAmount: allocation?.creditExcessAmount ?? 0,
      cardSurchargeBase: allocation?.cardSurchargeBase ?? 0,
      cardSurchargeAmount: allocation?.cardSurchargeAmount ?? 0,
      payableSettlementAmount: allocation?.payableSettlementAmount ?? 0,
    };
  }

  /**
   * 사용자 할인 옵션 자동 매칭 (fee/priceAdjustment 미설정 매핑만).
   * 발송확정은 매칭 결과를 저장하고, 신용초과 승인 요청은 저장 없이 금액 계산에만 사용한다 —
   * 두 경로가 같은 최종 정산금액을 계산해야 스냅샷 비교가 성립한다.
   */
  private applyAutoDiscountMatching(
    order: OrderEntity,
    userDiscounts: UserDiscountEntity[],
  ): {
    mappingsToUpdate: OrderProductMappingEntity[];
    mappingPriceAdjustments: Map<number, IPriceAdjustment | null>;
  } {
    const mappingsToUpdate: OrderProductMappingEntity[] = [];
    const mappingPriceAdjustments = new Map<number, IPriceAdjustment | null>();

    for (const mapping of order.orderProductMappings!) {
      let fee = mapping.fee;
      let priceAdjustment = mapping.priceAdjustment;

      // fee 또는 priceAdjustment가 설정되지 않은 경우 할인 옵션에서 찾기
      if (fee === null || priceAdjustment === null) {
        const matchingDiscount = findMatchingDiscount(
          {
            price: mapping.product.price,
            category: mapping.product.category,
            classificationId: mapping.product.classificationId,
            brand: mapping.product.brand,
          },
          userDiscounts,
        );

        if (matchingDiscount) {
          fee = fee ?? matchingDiscount.pricePercent;
          priceAdjustment = priceAdjustment ?? matchingDiscount.priceAdjustment;

          mapping.fee = fee;
          mapping.priceAdjustment = priceAdjustment;
          mappingsToUpdate.push(mapping);
        }
      }

      mappingPriceAdjustments.set(mapping.id, priceAdjustment);
    }

    return { mappingsToUpdate, mappingPriceAdjustments };
  }

  /**
   * 승인 요청 시점 스냅샷과 발송확정 시점 재계산 스냅샷을 비교한다.
   * 변경 항목이 있으면 발송하지 않고 재요청 필요로 분류되도록 drift 오류를 던진다.
   */
  private assertApprovalSnapshotMatches(
    approvalContext: CreditExcessApprovalExecutionContext,
    current: CreditExcessSnapshot,
  ): void {
    const changed = diffCreditExcessSnapshot(approvalContext.snapshot, current);
    if (changed.length > 0) {
      throw new CreditExcessApprovalDriftError(
        changed,
        `snapshot mismatch approvalId=${approvalContext.approvalId} fields=${changed.join('/')}`,
      );
    }
  }

  /**
   * 신용초과 승인 요청 생성을 위한 **서버 계산**. 클라이언트의 금액/계정 값은 받지 않는다.
   *
   * 주문 잠금 + billing scope 잠금 안에서 발송확정과 동일한 규칙으로 최종 정산금액과 신용초과액을
   * 계산하고 PII 최소화 스냅샷을 만든다. 신용초과가 없으면 승인 요청 대상이 아니다.
   */
  @Transactional()
  async buildCreditExcessApprovalRequest(
    user: ILoginUserInfo,
    body: { id: number; pointUseAmount?: number; depositUseEnabled?: boolean; depositUseAmount?: number },
  ): Promise<{
    orderId: number;
    billingUserId: number;
    walletAccountId: string | null;
    requestedAmount: number;
    requestedCreditExcessAmount: number;
    snapshot: CreditExcessSnapshot;
  }> {
    const lockedOrder = await this.orderRepository
      .createQueryBuilder('order')
      .setLock('pessimistic_write')
      .where('order.id = :id', { id: body.id })
      .andWhere('order.status = :status', { status: IOrderStatus.REVIEW_COMPLETE })
      .getOne();

    if (!lockedOrder) {
      throw new BadRequestException('해당 주문건은 존재하지 않거나, 검토완료 상태가 아닙니다.');
    }

    const currentUser = await this.getCurrentDeliveryTransitionUser(user.id);
    if (!canTransitionDelivery(currentUser, lockedOrder)) {
      throw new ForbiddenException('해당 주문에 대한 권한이 없습니다.');
    }

    const order = await this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.product', 'product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.classification', 'classification')
      .innerJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.id = :id', { id: body.id })
      .andWhere('order.status = :status', { status: IOrderStatus.REVIEW_COMPLETE })
      .getOne();

    if (!order) {
      throw new BadRequestException('해당 주문건은 존재하지 않거나, 검토완료 상태가 아닙니다.');
    }

    OrderValidation(order);

    const cutoverMode = this.walletCutoverConfig.pr2DeliveryLifecycleMode;
    assertWalletOnlyParamsAbsent(cutoverMode, body);

    if (!order.isNewBillingFlow) {
      throw new BadRequestException('해당 주문은 신용초과 승인 대상이 아닙니다.');
    }

    const billingUserId = order.clientUserId ?? order.userId;
    const { user: oneUser, companyUsers } = await this.lockBillingScope(billingUserId);

    const userDiscounts = (await this.userDiscountRepository.find({ where: { userId: billingUserId } })).filter(
      (discount) => discount.userId === billingUserId,
    );
    // 저장하지 않는다 — 발송확정과 동일한 금액을 계산하기 위한 in-memory 적용.
    this.applyAutoDiscountMatching(order, userDiscounts);

    const hasSettleInput = order.settleMethod != null;
    const resolvedSettlePolicy = hasSettleInput ? null : await this.resolveSettlePolicy(order, oneUser.company);
    const effectiveSettleMethod = order.settleMethod ?? resolvedSettlePolicy?.policy ?? 'CASH';
    const effectiveSurcharge = hasSettleInput
      ? order.cardSurchargeApplied
      : effectiveSettleMethod === 'CARD' && (resolvedSettlePolicy?.resolvedWallet?.cardSurchargeApplied ?? true);
    const finalAmount = calculateOrderSettlementAmount(order, effectiveSurcharge);

    const isCompanyBalanceMode = oneUser.company?.balanceManagementType === 'COMPANY';
    const effectiveBalance = isCompanyBalanceMode && oneUser.company ? oneUser.company.balance : oneUser.balance;
    const remainServiceAmount =
      oneUser.companyId && oneUser.company
        ? oneUser.company.maximumLimit + effectiveBalance - companyUsers.reduce((sum, u) => sum + u.allSettleAmount, 0)
        : effectiveBalance - oneUser.allSettleAmount;

    let walletAccountId: string | null = null;
    let excessAmount: number;
    let payableSettlementAmount: number;
    let allocationSnapshot: CreditExcessSnapshot['allocation'] = null;

    if (cutoverMode === WalletCutoverMode.WALLET) {
      const wallet = await this.walletAccountResolverService.resolveForOrder(order, this.orderRepository.manager);
      const allocationInput = await this.walletAllocationInputBuilder.build(order, wallet, finalAmount, {
        requestedPointAmount: body.pointUseAmount,
        depositUseEnabled: body.depositUseEnabled,
        depositUseAmount: body.depositUseAmount,
        companyId: oneUser.companyId,
        cardSurchargeApplied: effectiveSurcharge,
      });
      this.assertUsageWithinLimits(allocationInput, body);
      const allocation = this.paymentAllocationService.allocate(allocationInput);

      walletAccountId = String(wallet.id);
      excessAmount = allocation.creditExcessAmount;
      payableSettlementAmount = allocation.payableSettlementAmount;
      allocationSnapshot = {
        pointUsedAmount: allocation.pointUsedAmount,
        depositUsedAmount: allocation.depositUsedAmount,
        creditUsedAmount: allocation.creditUsedAmount,
        creditExcessAmount: allocation.creditExcessAmount,
        cardSurchargeAmount: allocation.cardSurchargeAmount,
      };
    } else {
      excessAmount = Math.max(0, finalAmount - remainServiceAmount);
      payableSettlementAmount = finalAmount;
    }

    if (excessAmount <= 0) {
      throw new BadRequestException('신용초과가 발생하지 않는 주문입니다. 발송확정을 다시 진행해 주세요.');
    }

    const snapshot = buildCreditExcessSnapshot({
      order,
      lifecycleMode: cutoverMode,
      billingUserId,
      walletAccountId,
      settleMethod: effectiveSettleMethod,
      cardSurchargeApplied: effectiveSurcharge,
      finalAmount,
      remainServiceAmount,
      excessAmount,
      payableSettlementAmount,
      usage: body,
      allocation: allocationSnapshot,
    });

    return {
      orderId: order.id,
      billingUserId,
      walletAccountId,
      requestedAmount: payableSettlementAmount,
      requestedCreditExcessAmount: excessAmount,
      snapshot,
    };
  }

  /**
   * 요청1 — 분배 미리보기 (dry-run). DB 차감/allocation row 생성 없음 (allocate 는 순수 함수).
   * 발송확정과 동일한 walletAllocationInputBuilder.build + allocate 경로를 거쳐 미리보기/확정 계산 일치 보장.
   * 권한·상태 검증도 발송확정과 동일 (타 주문 wallet/잔액 정보 노출 차단).
   */
  async previewAllocation(
    user: ILoginUserInfo,
    getBody: OrderAllocationPreviewReqDto,
  ): Promise<OrderAllocationPreviewResDto> {
    const { id } = getBody;

    const order = await this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.product', 'product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.classification', 'classification')
      .innerJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.id = :id', { id })
      .andWhere('order.status = :status', { status: IOrderStatus.REVIEW_COMPLETE })
      .getOne();

    if (!order) {
      throw new BadRequestException('해당 주문건은 존재하지 않거나, 검토완료 상태가 아닙니다.');
    }

    // 발송확정과 동일 service-level 권한 검증
    const currentUser = await this.getCurrentDeliveryTransitionUser(user.id);
    if (!canTransitionDelivery(currentUser, order)) {
      throw new ForbiddenException('해당 주문에 대한 권한이 없습니다.');
    }

    const billingUserId = order.clientUserId ?? order.userId;
    const billingUser = await this.userRepository.findOne({
      where: { id: billingUserId },
      relations: ['company'],
    });

    const wallet = await this.walletAccountResolverService.resolveForOrder(order);
    const effectiveSurcharge = await this.resolveEffectiveSurcharge(order, billingUser?.company);
    const finalAmount = calculateOrderSettlementAmount(order, effectiveSurcharge);

    const allocationInput = await this.walletAllocationInputBuilder.build(order, wallet, finalAmount, {
      requestedPointAmount: getBody.pointUseAmount,
      depositUseEnabled: getBody.depositUseEnabled,
      depositUseAmount: getBody.depositUseAmount,
      companyId: billingUser?.companyId ?? null,
      cardSurchargeApplied: effectiveSurcharge,
    });
    // clamp 금지 — 초과 입력은 400 (확정과 동일 규칙)
    this.assertUsageWithinLimits(allocationInput, getBody);

    const allocation = this.paymentAllocationService.allocate(allocationInput);

    const pointAllowableAmount = allocationInput.lines
      .filter((l) => l.pointPolicyEffect === 'ALLOW')
      .reduce((s, l) => s + l.grossSettlementAmount, 0);
    const pointDeniedAmount = allocationInput.lines
      .filter((l) => l.pointPolicyEffect === 'DENY')
      .reduce((s, l) => s + l.grossSettlementAmount, 0);

    return {
      walletAccountId: String(wallet.id),
      settleCondition: wallet.settleCondition,
      grossSettlementAmount: allocation.grossSettlementAmount,
      pointAllowableAmount,
      pointDeniedAmount,
      pointUsedAmount: allocation.pointUsedAmount,
      depositBalance: wallet.depositBalance,
      depositUsedAmount: allocation.depositUsedAmount,
      creditUsedAmount: allocation.creditUsedAmount,
      creditExcessAmount: allocation.creditExcessAmount,
      cardSurchargeApplied: allocation.cardSurchargeApplied,
      cardSurchargeBase: allocation.cardSurchargeBase,
      cardSurchargeAmount: allocation.cardSurchargeAmount,
      payableSettlementAmount: allocation.payableSettlementAmount,
    };
  }

  /**
   * 정산방법 정책 소스 (cutover mode 분기).
   * - WALLET: wallet_account.settleMethod (SoT). 미존재 시 fail-closed throw (회사 폴백 금지 — 잘못된 결제수단 영구저장 방지).
   * - SHADOW: wallet 조회 실패 시 경고 로그 후 회사 정책 폴백.
   * - LEGACY: 회사 정책.
   * resolvedWallet 은 호출측에서 재사용(추가 조회 회피)용으로 반환.
   */
  private async resolveSettlePolicy(
    order: Pick<OrderEntity, 'userId' | 'clientUserId'>,
    company: { settleMethod?: string | null } | null | undefined,
    manager?: EntityManager,
  ): Promise<{ policy: 'CARD' | 'CASH' | null; resolvedWallet: WalletAccountEntity | null }> {
    const mode = this.walletCutoverConfig.pr3SettleMode;
    const companyPolicy = (company?.settleMethod as 'CARD' | 'CASH' | null) ?? null;

    if (mode === WalletCutoverMode.WALLET) {
      const wallet = await this.walletAccountResolverService.resolveForOrder(order, manager);
      return { policy: wallet.settleMethod, resolvedWallet: wallet };
    }
    if (mode === WalletCutoverMode.SHADOW) {
      try {
        const wallet = await this.walletAccountResolverService.resolveForOrder(order, manager);
        return { policy: wallet.settleMethod, resolvedWallet: wallet };
      } catch (e) {
        this.logger.warn(`[settle policy] SHADOW wallet 조회 실패 → legacy(회사) 폴백: ${(e as Error).message}`);
        return { policy: companyPolicy, resolvedWallet: null };
      }
    }
    return { policy: companyPolicy, resolvedWallet: null };
  }

  /**
   * 정산 입력/수정 공통: billingUser 조회 → 회사 정책 → cutover 정책 → 최종 저장값 결정.
   * existingCardSurcharge / existingSettleMethod: update 시 기존 order 값(폴백 계층에 삽입). create 시 undefined.
   */
  private async resolveSettleInputs(
    order: Pick<OrderEntity, 'userId' | 'clientUserId' | 'settleMethod' | 'cardSurchargeApplied'>,
    body: { cardSurchargeApplied?: boolean; settleMethod?: 'CARD' | 'CASH' | null },
    opts: { useExistingAsMiddleFallback: boolean },
  ): Promise<{ cardSurchargeApplied: boolean; settleMethod: 'CARD' | 'CASH' | null }> {
    const billingUser = await this.userRepository.findOne({
      where: { id: order.clientUserId ?? order.userId },
      relations: ['company'],
    });
    const company = billingUser?.company;
    const { policy: settlePolicy, resolvedWallet } = await this.resolveSettlePolicy(order, company);
    // 카드할증 기본값도 정산방법(코드 지갑 SoT) 소스를 따른다 — wallet 토글(§4.0) 반영. wallet 미조회(LEGACY/SHADOW-실패)는 ?? true 로 현행 회사 CARD⇒기본 ON 보존.
    const defaultCardSurchargeApplied = settlePolicy === 'CARD' && (resolvedWallet?.cardSurchargeApplied ?? true);

    // 기존값 폴백은 정산완료(settleMethod!=null) update 에서만 — cardSurchargeApplied 는 non-nullable(false)이라 미정산 update 가 wallet 기본값을 가로채지 않게 게이트.
    const hasSettleInput = order.settleMethod != null;
    const existingSurcharge =
      opts.useExistingAsMiddleFallback && hasSettleInput ? order.cardSurchargeApplied : undefined;
    const cardSurchargeApplied = body.cardSurchargeApplied ?? existingSurcharge ?? defaultCardSurchargeApplied;

    // 정책 부재(LEGACY/SHADOW 회사 정책 null)에도 신규 저장은 항상 non-null — 기본값 'CASH'(할증OFF 와 정합).
    const settleMethod = opts.useExistingAsMiddleFallback
      ? (body.settleMethod ?? order.settleMethod ?? settlePolicy ?? 'CASH')
      : (body.settleMethod ?? settlePolicy ?? 'CASH');

    return { cardSurchargeApplied, settleMethod };
  }

  /**
   * 카드할증 effective 값 (settle 읽기/preview/confirm 공통, §4.0/§4.3 Y).
   * - 정산완료(settleMethod!=null): 저장된 order.cardSurchargeApplied.
   * - 미정산: resolveSettlePolicy 기반 wallet 토글 기본값(policy CARD & wallet 토글; wallet 미조회는 ?? true = 현행 회사 CARD⇒ON 보존).
   * 완료판정은 settleMethod (cardSurchargeApplied 는 non-nullable false 라 판정 불가). hasSettleInput 이면 resolveSettlePolicy 미호출(laziness).
   */
  private async resolveEffectiveSurcharge(
    order: Pick<OrderEntity, 'userId' | 'clientUserId' | 'settleMethod' | 'cardSurchargeApplied'>,
    company: { settleMethod?: string | null } | null | undefined,
  ): Promise<boolean> {
    if (order.settleMethod != null) return order.cardSurchargeApplied;
    const { policy, resolvedWallet } = await this.resolveSettlePolicy(order, company);
    return policy === 'CARD' && (resolvedWallet?.cardSurchargeApplied ?? true);
  }

  /**
   * TypeORM .withDeleted()가 LEFT JOIN된 product에 적용되지 않는 문제 우회.
   * 메인 쿼리 후 product가 null인 매핑에 대해 소프트 삭제된 상품을 보조 쿼리로 복구.
   */
  private async recoverDeletedProducts(orderProductMappings?: OrderProductMappingEntity[]): Promise<void> {
    if (!orderProductMappings) return;
    for (const mapping of orderProductMappings) {
      if (!mapping.product && mapping.productId) {
        const recovered = await this.productRepository.findOne({
          where: { id: mapping.productId },
          withDeleted: true,
          relations: ['brand', 'partnerCompany'],
        });
        if (recovered) {
          mapping.product = recovered;
        }
      }
    }
  }

  private buildManualEntries(orderId: number, list: ManualEntryItemDto[]): OrderManualEntryEntity[] {
    return list.map((entry, index) => {
      const entity = new OrderManualEntryEntity();
      entity.orderId = orderId;
      entity.rowIndex = index;
      entity.phoneNumber = this.cryptoCipher.encryptDeliveryTarget(
        PhoneUtil.normalizeDeliveryTarget(entry.phoneNumber),
      );
      entity.sendAmount = entry.sendAmount;
      entity.replaceCharacter1 = entry.replaceCharacter1 ?? null;
      entity.replaceCharacter2 = entry.replaceCharacter2 ?? null;
      entity.replaceCharacter3 = entry.replaceCharacter3 ?? null;
      entity.memo = entry.memo ?? null;
      return entity;
    });
  }

  /**
   * view_scope 기반 주문 조회 조건을 query builder 에 적용한다.
   * getList(목록)와 getDetail(상세)이 동일한 조회 범위 규칙을 공유하도록 공통화.
   * - SELF: 본인 주문 + 배정된 주문 + 담당 고객으로 지정된 주문
   * - COMPANY: 같은 회사 전체
   * - DEPARTMENT: 같은 부서 + 추가 부서들
   * - ALL: 제한 없음
   */
  private applyViewScopeFilter<T extends ObjectLiteral>(
    queryBuilder: SelectQueryBuilder<T>,
    user: ILoginUserInfo,
    currentUser: Pick<UserEntity, 'companyId' | 'departmentId'> | null,
    viewScope: UserViewScopeEntity | null,
  ): SelectQueryBuilder<T> {
    const scopeType = viewScope?.scopeType ?? ViewScopeType.SELF;

    // 본인 관련 주문 조회 조건 (본인 주문 + 배정된 주문 + 담당 고객으로 지정된 주문)
    const applyUserOrderFilter = () => {
      queryBuilder = queryBuilder.andWhere(
        '(order.userId = :userId OR order.operationUserId = :userId OR (order.clientUserId = :userId AND order.apiAppId IS NULL))',
        { userId: user.id },
      );
    };

    switch (scopeType) {
      case ViewScopeType.ALL:
        // 전체 조회 - 조건 없음
        break;
      case ViewScopeType.COMPANY:
        // 같은 회사 전체 조회
        if (currentUser?.companyId) {
          queryBuilder = queryBuilder.andWhere('user.companyId = :companyId', {
            companyId: currentUser.companyId,
          });
        } else {
          applyUserOrderFilter();
        }
        break;
      case ViewScopeType.DEPARTMENT: {
        // 같은 부서 + 추가 부서들 조회
        const deptIds = viewScope?.getDeptIdList() ?? [];
        const targetDeptIds = currentUser?.departmentId ? [currentUser.departmentId, ...deptIds] : deptIds;

        if (targetDeptIds.length > 0) {
          queryBuilder = queryBuilder.andWhere('user.departmentId IN (:...deptIds)', {
            deptIds: targetDeptIds,
          });
        } else {
          applyUserOrderFilter();
        }
        break;
      }
      case ViewScopeType.SELF:
      default:
        applyUserOrderFilter();
        break;
    }

    return queryBuilder;
  }

  private applyOrderSearchCondition<T extends ObjectLiteral>(
    queryBuilder: SelectQueryBuilder<T>,
    searchType: OrderSearchType | undefined,
    searchKeyword: string | undefined,
  ): SelectQueryBuilder<T> {
    if (!searchKeyword || searchKeyword.length < 1) {
      return queryBuilder;
    }

    switch (searchType) {
      case 'CUSTOMER':
        return queryBuilder.andWhere(
          '(COALESCE(order.snapshotBusinessName, userCompany.businessName) LIKE :keyword OR COALESCE(order.snapshotClientBusinessName, clientCompany.businessName) LIKE :keyword)',
          { keyword: `%${searchKeyword}%` },
        );
      case 'MANAGER':
        return queryBuilder.andWhere(
          '(COALESCE(order.snapshotPersonName, user.personName) LIKE :keyword OR COALESCE(order.snapshotClientPersonName, clientUser.personName) LIKE :keyword)',
          { keyword: `%${searchKeyword}%` },
        );
      case 'OPERATION_ADMIN':
        return queryBuilder.andWhere(
          'COALESCE(order.snapshotOperationPersonName, operationUser.personName) LIKE :keyword',
          { keyword: `%${searchKeyword}%` },
        );
      case 'EVENT':
        return queryBuilder.andWhere('order.eventName LIKE :keyword', { keyword: `%${searchKeyword}%` });
      case 'PRODUCT':
        return queryBuilder.andWhere('product.name LIKE :keyword', { keyword: `%${searchKeyword}%` });
      case 'ALL':
      default:
        return queryBuilder.andWhere(
          `(${[
            'COALESCE(order.snapshotBusinessName, userCompany.businessName) LIKE :keyword',
            'COALESCE(order.snapshotClientBusinessName, clientCompany.businessName) LIKE :keyword',
            'COALESCE(order.snapshotPersonName, user.personName) LIKE :keyword',
            'COALESCE(order.snapshotClientPersonName, clientUser.personName) LIKE :keyword',
            'COALESCE(order.snapshotOperationPersonName, operationUser.personName) LIKE :keyword',
            'order.eventName LIKE :keyword',
            'product.name LIKE :keyword',
          ].join(' OR ')})`,
          { keyword: `%${searchKeyword}%` },
        );
    }
  }

  private async buildOrderListQuery(
    user: ILoginUserInfo,
    params: OrderListQueryParams,
  ): Promise<SelectQueryBuilder<OrderEntity>> {
    const { section, type, status, startAt, endAt, searchType, searchKeyword, sendingType, dateType } = params;

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .withDeleted()
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.type = :type', { type })
      .andWhere('order.deletedAt IS NULL');

    const currentUser = await this.userRepository.findOne({
      where: { id: user.id },
      select: ['id', 'companyId', 'departmentId'],
    });

    const viewScope = await this.userViewScopeRepository.findOne({
      where: { userId: user.id },
    });

    if (section === IOrderSection.ORDER) {
      queryBuilder = this.applyViewScopeFilter(queryBuilder, user, currentUser, viewScope);
    }

    if (section === IOrderSection.SHIPPING) {
      queryBuilder = queryBuilder.andWhere('order.status != :tempStatus', { tempStatus: IOrderStatus.TEMP });
      queryBuilder = this.applyViewScopeFilter(queryBuilder, user, currentUser, viewScope);
    }

    this.applyDirectSendingFilter(queryBuilder, user, sendingType);
    if (params.hasFailedDelivery === true) {
      queryBuilder = queryBuilder.andWhere(
        (subQuery) =>
          `EXISTS ${subQuery
            .subQuery()
            .select('1')
            .from(OrderDeliveryEntity, 'failedDelivery')
            .innerJoin(
              OrderProductMappingEntity,
              'failedOrderProductMapping',
              'failedOrderProductMapping.id = failedDelivery.orderProductMappingId',
            )
            .where('failedOrderProductMapping.orderId = order.id')
            .andWhere('failedDelivery.deletedAt IS NULL')
            .andWhere('failedDelivery.resendAt IS NULL')
            .andWhere('failedDelivery.status IN (:...failedDeliveryStatuses)')
            .getQuery()}`,
        {
          failedDeliveryStatuses: [IOrderDeliveryStatus.FAIL, IOrderDeliveryStatus.FAIL_SMS],
        },
      );
    }

    if (status) {
      queryBuilder = queryBuilder.andWhere('order.status = :status', { status });
    }

    queryBuilder = this.applyOrderSearchCondition(queryBuilder, searchType, searchKeyword);
    queryBuilder = this.applyOrderDateCondition(queryBuilder, dateType, startAt, endAt);
    return queryBuilder.orderBy('order.id', 'DESC');
  }

  /**
   * 보조 조회(리포트 이력 등)용 소유검증: 주문이 호출자의 view_scope 안에 있지 않으면 거부.
   * applyViewScopeFilter 와 동일 기준으로 IDOR(타사 주문 id 순회)을 차단한다.
   */
  async assertOrderInViewScope(user: ILoginUserInfo, orderId: number): Promise<void> {
    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoin('order.user', 'user')
      .withDeleted()
      .where('order.id = :id', { id: orderId });

    const currentUser = await this.userRepository.findOne({
      where: { id: user.id },
      select: ['id', 'companyId', 'departmentId'],
    });
    const viewScope = await this.userViewScopeRepository.findOne({
      where: { userId: user.id },
    });
    queryBuilder = this.applyViewScopeFilter(queryBuilder, user, currentUser, viewScope);

    const count = await queryBuilder.getCount();
    if (count === 0) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }
  }

  private async findReportOrderInViewScope(
    user: ILoginUserInfo,
    orderId: number,
    withReportRelations = false,
  ): Promise<OrderEntity> {
    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .withDeleted()
      .where('order.id = :id', { id: orderId })
      .andWhere('order.deletedAt IS NULL');

    if (withReportRelations) {
      queryBuilder = queryBuilder
        .leftJoinAndSelect('order.operationUser', 'operationUser')
        .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
        .leftJoinAndSelect('orderProductMappings.product', 'product')
        .leftJoinAndSelect('product.brand', 'brand')
        .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries');
    }

    const currentUser = await this.userRepository.findOne({
      where: { id: user.id },
      select: ['id', 'companyId', 'departmentId'],
    });
    const viewScope = await this.userViewScopeRepository.findOne({
      where: { userId: user.id },
    });
    queryBuilder = this.applyViewScopeFilter(queryBuilder, user, currentUser, viewScope);

    const order = await queryBuilder.getOne();

    if (!order) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    return order;
  }

  private async findDeliveryCompleteOrderInViewScope(
    user: ILoginUserInfo,
    orderId: number,
    withReportRelations = false,
  ): Promise<OrderEntity> {
    const order = await this.findReportOrderInViewScope(user, orderId, withReportRelations);

    if (order.status !== IOrderStatus.DELIVERY_COMPLETE) {
      throw new BadRequestException('발송 완료된 건에 대해서만 조회 가능합니다.');
    }

    return order;
  }

  private async findOrderProductMappingInViewScope(
    user: ILoginUserInfo,
    orderProductMappingId: number,
    relations: Array<'product' | 'product.brand' | 'product.partnerCompany'> = [],
  ): Promise<OrderProductMappingEntity | null> {
    let queryBuilder = this.orderProductMappingRepository
      .createQueryBuilder('orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('order.user', 'user')
      .where('orderProductMapping.id = :id', { id: orderProductMappingId });

    if (
      relations.includes('product') ||
      relations.includes('product.brand') ||
      relations.includes('product.partnerCompany')
    ) {
      queryBuilder = queryBuilder.leftJoinAndSelect('orderProductMapping.product', 'product');
    }

    if (relations.includes('product.brand')) {
      queryBuilder = queryBuilder.leftJoinAndSelect('product.brand', 'brand');
    }

    if (relations.includes('product.partnerCompany')) {
      queryBuilder = queryBuilder.leftJoinAndSelect('product.partnerCompany', 'partnerCompany');
    }

    const currentUser = await this.userRepository.findOne({
      where: { id: user.id },
      select: ['id', 'companyId', 'departmentId'],
    });
    const viewScope = await this.userViewScopeRepository.findOne({
      where: { userId: user.id },
    });

    queryBuilder = this.applyViewScopeFilter(queryBuilder, user, currentUser, viewScope);
    this.applyDirectSendingFilter(queryBuilder, user);
    return queryBuilder.getOne();
  }

  async getList(user: ILoginUserInfo, getQuery: OrderGetListReqDto): Promise<OrderGetListResDto> {
    const { page, take } = getQuery;
    let queryBuilder = await this.buildOrderListQuery(user, getQuery);

    const skip = (page - 1) * take;
    queryBuilder = queryBuilder.take(take).skip(skip);
    const [orderList, totalCount] = await queryBuilder.getManyAndCount();
    const totalPage = Math.ceil(totalCount / take);

    const resultList: OrderViewDto[] = orderList.map((order) => {
      let totalAmount = 0;
      let totalProductCount = 0;
      let productName = '';
      let actualSendAt: string | null = null;

      if (order.orderProductMappings && order.orderProductMappings.length > 0) {
        totalAmount = order.orderProductMappings.reduce((acc, cur) => {
          return acc + cur.amount;
        }, 0);
        totalProductCount = order.orderProductMappings.length;
        const firstProduct = order.orderProductMappings[0].product;
        productName = firstProduct ? firstProduct.name : '(삭제된 상품)';
        const orderProductMappingsLength = order.orderProductMappings.length;
        if (orderProductMappingsLength - 1 > 0) {
          productName += `외 ${orderProductMappingsLength - 1}건`;
        }

        // 실제 발송 시간: 성공한 배송 건 중 하나의 actualSendAt 사용
        // 목록 표시는 활성 배송건만 사용한다. soft-delete 배송건은 파기확인서 게이트 판정에만 쓴다.
        for (const mapping of order.orderProductMappings) {
          for (const delivery of (mapping.orderDeliveries ?? []).filter((d) => d.deletedAt == null)) {
            if (
              delivery.actualSendAt &&
              (delivery.status === IOrderDeliveryStatus.COMPLETE ||
                delivery.status === IOrderDeliveryStatus.COMPLETE_SMS)
            ) {
              actualSendAt = format(delivery.actualSendAt, DateFormatStr);
              break;
            }
          }
          if (actualSendAt) break;
        }
      }

      // 미해결 발송 실패 건 포함 여부 확인 (활성 배송건만)
      // 재발송 성공 시에도 status 는 FAIL/FAIL_SMS 로 남고 resendAt 만 채워지므로,
      // resendAt 이 없는 건(= 아직 재발송되지 않은 실패)만 실패로 본다.
      const hasFailedDelivery =
        order.orderProductMappings?.some((mapping) =>
          mapping.orderDeliveries
            ?.filter((delivery) => delivery.deletedAt == null)
            .some(
              (delivery) =>
                (delivery.status === IOrderDeliveryStatus.FAIL || delivery.status === IOrderDeliveryStatus.FAIL_SMS) &&
                delivery.resendAt == null,
            ),
        ) ?? false;

      // 재발송 완료 건 포함 여부 확인 (활성 배송건만)
      const hasResentDelivery =
        order.orderProductMappings?.some((mapping) =>
          mapping.orderDeliveries
            ?.filter((delivery) => delivery.deletedAt == null)
            .some((delivery) => delivery.resendAt != null),
        ) ?? false;

      // 파기확인서 발행 가능 여부 (deliveryTarget 단일 컬럼 판정 — destruction.certificate.gate 참조)
      const destructionCertificateGate = resolveDestructionCertificateGate(order);

      // 첫 번째 상품의 발송 정보 사용
      const firstMapping = order.orderProductMappings?.[0];
      // sendRequestAt: 예약 발송 요청 시간 (actualSendAt이 없을 때 폴백용)
      const sendRequestAt = firstMapping?.sendRequestAt ? format(firstMapping.sendRequestAt, DateFormatStr) : null;

      // 상품별 발송시간 배열 채움 게이트: 혼합 발송(IMMEDIATE+RESERVE) 또는 RESERVE 분 단위 distinct ≥ 2
      const allMappings = order.orderProductMappings ?? [];
      // 슬롯 산정(distinct 항): sendRequestAt 존재 RESERVE 매핑의 분 슬롯 distinct (기존 유지)
      const distinctReserveMinuteSlots = new Set(
        allMappings
          .filter((m) => m.sendType === 'RESERVE' && m.sendRequestAt)
          .map((m) => Math.floor(m.sendRequestAt!.getTime() / 60000)),
      ).size;
      // 혼합 판정: IMMEDIATE ≥1 AND RESERVE ≥1 (매핑 카운트 기반, productSendTimes와 독립·응답 미노출)
      const isMixedSendType =
        allMappings.some((m) => m.sendType === 'IMMEDIATE') && allMappings.some((m) => m.sendType === 'RESERVE');

      // per-mapping actualSendAt: 활성 COMPLETE/COMPLETE_SMS 중 가장 최근 값 (RESERVE·IMMEDIATE 공용)
      const resolveMappingActualSendAt = (
        deliveries:
          | { deletedAt?: Date | null; actualSendAt?: Date | null; status: IOrderDeliveryStatus }[]
          | null
          | undefined,
      ): string | null => {
        const maxActualSendAt = (deliveries ?? [])
          .filter(
            (d) =>
              d.deletedAt == null &&
              d.actualSendAt &&
              (d.status === IOrderDeliveryStatus.COMPLETE || d.status === IOrderDeliveryStatus.COMPLETE_SMS),
          )
          .reduce<Date | null>((max, d) => (max === null || d.actualSendAt! > max ? d.actualSendAt! : max), null);
        return maxActualSendAt ? format(maxActualSendAt, DateFormatStr) : null;
      };

      let productSendTimes:
        | {
            productName: string;
            sendType: 'IMMEDIATE' | 'RESERVE';
            sendRequestAt: string | null;
            actualSendAt: string | null;
          }[]
        | undefined;
      if (isMixedSendType || distinctReserveMinuteSlots >= 2) {
        // 배열 산출: sendType ∈ {RESERVE, IMMEDIATE}인 전 매핑 (Case-G 포함, 슬롯 산정과 독립)
        productSendTimes = allMappings
          .filter((m) => m.sendType === 'IMMEDIATE' || m.sendType === 'RESERVE')
          .map((m) => ({
            productName: m.product?.name ?? '(삭제된 상품)',
            sendType: m.sendType as 'IMMEDIATE' | 'RESERVE',
            sendRequestAt: m.sendType === 'RESERVE' && m.sendRequestAt ? format(m.sendRequestAt, DateFormatStr) : null,
            actualSendAt: resolveMappingActualSendAt(m.orderDeliveries),
          }));
      }

      // 주문 시점 스냅샷 우선, NULL이면 clientUser ?? user FK로 fallback
      const billing = readBillingView(order);

      return {
        id: order.id,
        registerAt: format(order.registerAt, DateFormatStr),
        userBusinessName: billing.businessName,
        userPersonName: billing.personName,
        eventName: order.eventName,
        productName: productName,
        totalProductCount: totalProductCount,
        totalAmount: totalAmount,
        status: order.status,
        sendRequestAt: sendRequestAt,
        actualSendAt: actualSendAt,
        operationUserId: order.operationUserId,
        operationUserName: readOperationPersonName(order),
        deliveryPrice: order.sendAmount,
        settlePrice: order.settleAmount,
        requestToDestroyPersonalInfoDay: firstMapping?.requestToDestroyPersonalInfoDay ?? 0,
        sendType: firstMapping?.sendType ?? null,
        hasFailedDelivery,
        hasResentDelivery,
        canIssueDestructionCertificate: destructionCertificateGate.canIssue,
        destructionCertificateBlockReason: destructionCertificateGate.reason,
        productSendTimes,
      };
    });

    return { list: resultList, totalPage, totalCount, currentPage: page };
  }
  async getListSummary(
    user: ILoginUserInfo,
    params: Omit<OrderListQueryParams, 'status'>,
  ): Promise<{
    total: number;
    deliveryRequest: number;
    reviewComplete: number;
    deliveryConfirmed: number;
    deliveryComplete: number;
    deliveryCancel: number;
    failed: number;
  }> {
    const queryBuilder = await this.buildOrderListQuery(user, { ...params, status: undefined });
    const summary = await queryBuilder
      .clone()
      .orderBy()
      .select([
        'COUNT(DISTINCT order.id) AS total',
        `COUNT(DISTINCT CASE WHEN order.status = '${IOrderStatus.DELIVERY_REQUEST}' THEN order.id END) AS deliveryRequest`,
        `COUNT(DISTINCT CASE WHEN order.status = '${IOrderStatus.REVIEW_COMPLETE}' THEN order.id END) AS reviewComplete`,
        `COUNT(DISTINCT CASE WHEN order.status = '${IOrderStatus.DELIVERY_CONFIRMED}' THEN order.id END) AS deliveryConfirmed`,
        `COUNT(DISTINCT CASE WHEN order.status = '${IOrderStatus.DELIVERY_COMPLETE}' THEN order.id END) AS deliveryComplete`,
        `COUNT(DISTINCT CASE WHEN order.status = '${IOrderStatus.DELIVERY_CANCEL}' THEN order.id END) AS deliveryCancel`,
      ])
      .getRawOne<{
        total: string;
        deliveryRequest: string;
        reviewComplete: string;
        deliveryConfirmed: string;
        deliveryComplete: string;
        deliveryCancel: string;
      }>();

    const failedRows = await (
      await this.buildOrderListQuery(user, { ...params, status: undefined, hasFailedDelivery: true })
    )
      .clone()
      .orderBy()
      .select('COUNT(DISTINCT order.id)', 'failed')
      .getRawOne<{ failed: string }>();

    return {
      total: Number(summary?.total ?? 0),
      deliveryRequest: Number(summary?.deliveryRequest ?? 0),
      reviewComplete: Number(summary?.reviewComplete ?? 0),
      deliveryConfirmed: Number(summary?.deliveryConfirmed ?? 0),
      deliveryComplete: Number(summary?.deliveryComplete ?? 0),
      deliveryCancel: Number(summary?.deliveryCancel ?? 0),
      failed: Number(failedRows?.failed ?? 0),
    };
  }

  private static readonly CUSTOMER_SETTLEMENT_ROLES: ReadonlyArray<IUserAuthority> = [
    IUserAuthority.SUPER_ADMIN,
    IUserAuthority.OPERATION_ADMIN,
  ];

  /** customerSettlement 노출 화이트리스트 (운영관리자 이상). 쿠키 authority 는 UI 힌트일 뿐 이 서버 필터가 유일 방어선. */
  private static canViewCustomerSettlement(user: ILoginUserInfo): boolean {
    return OrderService.CUSTOMER_SETTLEMENT_ROLES.includes(user.authority as IUserAuthority);
  }

  /**
   * 발송관리 고객사 호버 툴팁용 정산정보 조회.
   * 목록(/order/list) 응답에 싣지 않고 분리한 이유 = 화면 최초 렌더를 지갑 조회에 묶지 않기 위함(지연 로딩).
   * - settleCondition SoT = wallet_account.settle_condition (user 컬럼은 deprecated).
   * - remainServiceAmount = creditLimit + depositBalance − creditUsedAmount − creditExcessAmount, 0-clamp.
   * - 정산코드 미부여 / wallet_account 미존재 주문은 응답에서 생략한다(프론트는 '정보 없음' 처리).
   * - 권한 미달이면 빈 목록. 조회 범위(view_scope) 밖 주문 id 는 자동 제외되어 IDOR 로 타사 잔액을 캐낼 수 없다.
   * - type(GENERAL/SSG) 로 주문 유형을 함께 필터링한다. 컨트롤러의 SEND_GENERAL/SEND_SSG 검증과 짝이며,
   *   유형이 다른 주문 id 는 조회되지 않는다(교차 유형 우회 차단).
   * - 쿼리 수는 주문 id 개수와 무관하게 고정: 주문 배치 1회 + wallet 배치 1회 + view_scope 확인 2회(user, user_view_scope).
   *   즉 정상 요청당 총 4회이며, id 가 늘어도 늘지 않는다(N+1 없음).
   */
  async getCustomerSettlement(
    user: ILoginUserInfo,
    getQuery: OrderGetCustomerSettlementReqDto,
  ): Promise<OrderGetCustomerSettlementResDto> {
    const ids = [...new Set(getQuery.ids ?? [])];
    if (ids.length === 0 || !OrderService.canViewCustomerSettlement(user)) {
      return { list: [] };
    }

    const currentUser = await this.userRepository.findOne({
      where: { id: user.id },
      select: ['id', 'companyId', 'departmentId'],
    });
    const viewScope = await this.userViewScopeRepository.findOne({
      where: { userId: user.id },
    });

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoin('order.user', 'user')
      .leftJoin('order.clientUser', 'clientUser')
      .select(['order.id', 'user.id', 'user.settlementCode', 'clientUser.id', 'clientUser.settlementCode'])
      .where('order.id IN (:...ids)', { ids })
      // 교차 유형 조회 차단: 컨트롤러가 검증한 권한(SEND_GENERAL/SEND_SSG)과 실제 주문 유형을 일치시킨다.
      // (SEND_GENERAL 만 가진 운영자가 type=GENERAL 로 SSG 주문 id 를 캐는 경로 봉쇄)
      .andWhere('order.type = :type', { type: getQuery.type });
    queryBuilder = this.applyViewScopeFilter(queryBuilder, user, currentUser, viewScope);

    const orders = await queryBuilder.getMany();

    // 과금 대상(대행주문이면 clientUser) 기준 정산코드. 코드 미부여 주문은 조회 대상에서 제외.
    const codeByOrderId = new Map<number, string>();
    for (const order of orders) {
      const settlementCode = (order.clientUser ?? order.user)?.settlementCode || null;
      if (settlementCode) {
        codeByOrderId.set(order.id, settlementCode);
      }
    }
    if (codeByOrderId.size === 0) {
      return { list: [] };
    }

    const wallets = await this.walletAccountRepository.find({
      where: { ownerType: 'SETTLEMENT_CODE', ownerId: In([...new Set(codeByOrderId.values())]) },
    });
    const walletByCode = new Map(wallets.map((wallet) => [wallet.ownerId, wallet]));

    const list: CustomerSettlementViewDto[] = [];
    codeByOrderId.forEach((settlementCode, orderId) => {
      const wallet = walletByCode.get(settlementCode);
      if (!wallet) {
        return;
      }
      const remain = wallet.creditLimit + wallet.depositBalance - wallet.creditUsedAmount - wallet.creditExcessAmount;
      list.push({
        orderId,
        settleCondition: wallet.settleCondition,
        remainServiceAmount: Math.max(0, remain),
      });
    });

    return { list };
  }

  async getDetail(user: ILoginUserInfo, getParam: OrderGetDetailReqParamDto): Promise<OrderGetDetailResDto> {
    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .withDeleted()
      .where('order.id = :id', { id: getParam.id })
      .addOrderBy('orderDeliveries.id', 'ASC');

    // IDOR 방지: 호출자의 조회 범위(view_scope)를 getList 와 동일하게 적용.
    // 범위를 벗어난 주문은 조회되지 않아 아래 not-found 처리로 거부된다.
    const currentUser = await this.userRepository.findOne({
      where: { id: user.id },
      select: ['id', 'companyId', 'departmentId'],
    });
    const viewScope = await this.userViewScopeRepository.findOne({
      where: { userId: user.id },
    });
    queryBuilder = this.applyViewScopeFilter(queryBuilder, user, currentUser, viewScope);

    const order = await queryBuilder.getOne();

    if (!order) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    await this.recoverDeletedProducts(order.orderProductMappings);

    // '폐기 후 신규 발송' 신규 건 숨김 — 고객사에는 최초 발송 1건만 노출 (전체 이력은 CS 발송상세)
    this.hideDiscardReissueDeliveries(order.orderProductMappings);

    const productList: OrderDetailProductDto[] = [];
    const orderProductMappingIds = (order.orderProductMappings ?? []).map((mapping) => mapping.id);
    const testDeliveryHistoryMap = new Map<number, OrderTestDeliveryHistoryDto[]>();

    if (orderProductMappingIds.length > 0) {
      const loaded = await this.loadTestDeliveryHistories(orderProductMappingIds);
      for (const [mappingId, histories] of loaded) {
        testDeliveryHistoryMap.set(mappingId, histories);
      }
    }

    // 발송건별 부분취소 가능 여부 판정 기준 시각 — 루프 밖에서 1회 생성해 행마다 흔들리지 않게 한다.
    const now = new Date();

    let topImagePath;
    let midImagePath;

    if (order.orderProductMappings && order.orderProductMappings.length > 0) {
      for (const orderProductMapping of order.orderProductMappings) {
        const orderDeliveryList: OrderViewDeliveryDto[] = [];

        // 발송 완료된 건: 저장된 expireAt 직접 사용, 미발송건: 예약/즉시 기준 계산
        const firstDelivery = orderProductMapping.orderDeliveries?.[0];
        const expireAt = this.resolveOrderExpireAt(orderProductMapping, firstDelivery?.expireAt);
        const expireDate = expireAt ? dayjs(expireAt).tz('Asia/Seoul').format('YYYY. MM. DD') : null;

        for (const orderDelivery of orderProductMapping.orderDeliveries) {
          // deliveryTarget 복호화 (originalDeliveryTarget 우선 사용)
          const targetToDecrypt = orderDelivery.originalDeliveryTarget || orderDelivery.deliveryTarget;
          const decryptedDeliveryTarget = this.cryptoCipher.safeDecryptDeliveryTarget(targetToDecrypt) ?? '';

          // 부분취소 가능 여부(화면 표시용). 권위 게이트는 findCancelableDeliveryIds+CAS.
          // ★ 발송건 술어(evaluateDeliveryCancelable)에 더해 주문 레벨 게이트를 함께 적용한다.
          //   partialDeliveryCancel 은 발송건 조건을 보기 전에 SSG 주문을 400 으로 선차단하는데,
          //   그걸 반영하지 않으면 SSG 주문의 WAIT 예약건이 cancelable=true 로 내려가 "선택은 되는데
          //   제출하면 400" 이 된다. 발송건 SQL(findCancelableDeliveryIds)에는 없는 order-level 게이트라
          //   술어가 아니라 여기서 order.type 으로 판정한다.
          //   (레거시 non-wallet 주문도 400 이지만 wallet 여부는 비동기 조회라 여기서 보지 않는다 —
          //    그 조합은 WAIT 예약건이 사실상 드물어 후속 항목으로 남긴다.)
          const perDelivery = evaluateDeliveryCancelable(orderDelivery, order.type, now);
          const orderLevelBlock = order.type === IOrderType.SSG ? DeliveryCancelBlockReason.UNSUPPORTED_ORDER : null;

          orderDeliveryList.push({
            id: orderDelivery.id,
            deliveryTarget: decryptedDeliveryTarget,
            replaceCharacter1: orderDelivery.replaceCharacter1,
            replaceCharacter2: orderDelivery.replaceCharacter2,
            replaceCharacter3: orderDelivery.replaceCharacter3,
            memo: orderDelivery.memo,
            status: orderDelivery.status,
            isResent: orderDelivery.resendAt !== null,
            cancelable: orderLevelBlock === null && perDelivery.cancelable,
            cancelBlockReason: orderLevelBlock ?? perDelivery.blockReason,
          });
        }

        topImagePath = orderProductMapping.topImagePath ?? OrderService.DEFAULT_TOP_IMAGE_PATH;
        midImagePath = orderProductMapping.midImagePath ?? OrderService.DEFAULT_MID_IMAGE_PATH;

        const product = orderProductMapping.product
          ? {
              id: orderProductMapping.product.id,
              name: orderProductMapping.product.name,
              price: orderProductMapping.product.price,
              expireDay: orderProductMapping.product.expireDay,
              expireDate: expireDate,
              amount: orderProductMapping.amount,
              imagePath: orderProductMapping.product.imagePath,
              brandId: orderProductMapping.product.brandId,
              brandName: orderProductMapping.product.brand?.nameKorean ?? '',
              partnerCompanyName: orderProductMapping.product.partnerCompany?.businessName ?? '',
            }
          : {
              id: orderProductMapping.productId,
              name: '(삭제된 상품)',
              price: 0,
              expireDay: 0,
              expireDate: null,
              amount: orderProductMapping.amount,
              imagePath: '',
              brandId: 0,
              brandName: '',
              partnerCompanyName: '',
            };

        // 해당 상품의 미해결 발송 실패 건수 계산 (재발송 완료 건 제외 — resendAt 이 채워지면 실패로 세지 않는다)
        const failCount = orderProductMapping.orderDeliveries.filter(
          (delivery) =>
            (delivery.status === IOrderDeliveryStatus.FAIL || delivery.status === IOrderDeliveryStatus.FAIL_SMS) &&
            delivery.resendAt == null,
        ).length;

        productList.push({
          id: orderProductMapping.id,
          product: product,
          orderDeliveryList: orderDeliveryList,

          emailSendType: orderProductMapping.emailSendType,
          emailFinalSendMethod: orderProductMapping.emailFinalSendMethod,
          fromEmail: orderProductMapping.fromEmail,
          fromPhoneNumber: orderProductMapping.fromPhoneNumber,
          requestToDestroyPersonalInfoDay: orderProductMapping.requestToDestroyPersonalInfoDay,
          sendContent: orderProductMapping.sendContent ?? '',
          sendMethod: orderProductMapping.sendMethod!,
          sendRequestAt: orderProductMapping.sendRequestAt
            ? format(orderProductMapping.sendRequestAt, DateFormatStr)
            : null,
          sendTailText: orderProductMapping.sendTailText,
          sendTitle: orderProductMapping.sendTitle ?? '',
          sendType: orderProductMapping.sendType,
          useEmailContent: orderProductMapping.useEmailContent,
          encourageDay: orderProductMapping.encourageDay,
          galaxiaDuration: orderProductMapping.galaxiaDuration,
          failCount: failCount,
          testDeliveryHistories: testDeliveryHistoryMap.get(orderProductMapping.id) ?? [],
          // 자사 운영자(SUPER_ADMIN/OPERATION_ADMIN)에게만 가격 divergence 노출.
          // 고객사(CORPORATE_ADMIN) 또는 미인증 경로에서는 필드 자체를 omit.
          ...(user.authority === IUserAuthority.SUPER_ADMIN || user.authority === IUserAuthority.OPERATION_ADMIN
            ? buildPriceDivergence(orderProductMapping)
            : {}),
        });
      }
    }

    // 총 발송 실패 건수 계산
    const totalFailCount = productList.reduce((acc, product) => acc + product.failCount, 0);

    let couponExpiration: number | null = null;
    if (order.type === IOrderType.SSG && productList.length > 0) {
      couponExpiration = productList[0].product?.expireDay ?? null;
    }

    const clientView = readClientUserView(order);

    // SSG 행사잔액 이상 탐지(읽기전용). 게이트 3중:
    // (1) 타입 SSG (2) 발송확정 전(REVIEW_COMPLETE) (3) 발송확정 권한자(canTransitionDelivery).
    // 민감 재무데이터(행사잔액·SSG 집계금액)라 비권한자(고객사/비소유 운영자)에겐 필드를 omit한다.
    let ssgBalanceCheck: SsgBalanceCheckView | undefined;
    const transitionUser = await this.getCurrentDeliveryTransitionUser(user.id);
    if (shouldExposeSsgBalanceCheck(transitionUser, order)) {
      const result = await this.ssgEventService.getSsgBalanceCheckForOrder(order.id);
      ssgBalanceCheck = result ? toSsgBalanceCheckView(result) : undefined;
    }
    const wallet = await this.walletAccountResolverService.resolveForOrder(order);

    return {
      id: order.id,
      registerAt: format(order.registerAt, DateFormatStr),
      eventName: order.eventName,
      type: order.type,
      topImagePath,
      midImagePath,
      status: order.status,
      couponExpiration: couponExpiration,
      productList: productList,
      settlePeriodCondition: order.user!.settlePeriodCondition,
      settlePeriodCount: order.user!.settlePeriodCount,
      isPreSettle: wallet.settleCondition === IUserSettleCondition.PRE_PAYMENT,
      cancelReason: order.cancelReason,
      canceledAt: order.canceledAt ? format(order.canceledAt, DateFormatStr) : null,
      totalFailCount: totalFailCount,
      // 대행주문 관련 정보 (주문 시점 스냅샷 우선)
      clientUserId: order.clientUserId ?? null,
      clientUserName: clientView?.personName ?? null,
      clientCompanyName: clientView?.businessName ?? null,
      operationUserId: order.operationUserId ?? null,
      operationUserName: readOperationPersonName(order),
      ssgBalanceCheck,
    };
  }

  /**
   * 발송 중복 검증(감사)
   * - 주문에 속한 order_delivery 전체를 집계해 중복 발송 흔적을 찾는다.
   * - 일반 주문: 동일 deliveryTarget 2건 이상 + 일자별 이상 탐지
   * - SSG 주문: 추가로 ssgTransactionId / barCode 중복 검사
   */
  async getDeliveryAudit(orderId: number): Promise<OrderGetDeliveryAuditResDto> {
    const order = await this.orderRepository.findOne({ where: { id: orderId } });
    if (!order) {
      throw new BadRequestException(`해당 주문(${orderId})이 존재하지 않습니다.`);
    }

    const qr = this.orderRepository.manager.connection.createQueryRunner();
    await qr.connect();
    try {
      // GROUP_CONCAT 기본 1024바이트 한도를 확장해 중복 목록 잘림 방지
      await qr.query('SET SESSION group_concat_max_len = 1000000');

      const summary = await this.fetchAuditSummary(qr, orderId);
      const dailyStats = await this.fetchAuditDailyStats(qr, orderId);
      const duplicates = await this.fetchAuditDuplicates(qr, orderId);
      const ssgDuplicates = order.type === IOrderType.SSG ? await this.fetchSsgDuplicates(qr, orderId) : [];

      const isDuplicateDetected =
        duplicates.some((d) => !d.isLegitimate) || dailyStats.some((d) => d.isSuspicious) || ssgDuplicates.length > 0;

      return {
        orderId: order.id,
        eventName: order.eventName,
        orderType: order.type,
        orderStatus: order.status,
        isDuplicateDetected,
        summary,
        dailyStats,
        duplicates,
        ssgDuplicates,
      };
    } finally {
      await qr.release();
    }
  }

  private static readonly AUDIT_BASE_WHERE = `
    FROM order_delivery od
    INNER JOIN order_product_mapping opm ON opm.id = od.order_product_mapping_id
    WHERE opm.order_id = ?
      AND od.deleted_at IS NULL
      AND opm.deleted_at IS NULL`;

  private parseIdList(raw: unknown): number[] {
    return String(raw ?? '')
      .split(',')
      .filter((x) => x !== '')
      .map(Number);
  }

  private parseNullableIdList(raw: unknown): (number | null)[] {
    return String(raw ?? '')
      .split(',')
      .map((x) => (x === 'NULL' || x === '' ? null : Number(x)));
  }

  private parseNullableStringList(raw: unknown): (string | null)[] {
    return String(raw ?? '')
      .split(',')
      .map((x) => (x === '' ? null : x));
  }

  private async fetchAuditSummary(qr: QueryRunner, orderId: number): Promise<OrderDeliveryAuditSummaryDto> {
    const S = IOrderDeliveryStatus;
    const rows: Array<Record<string, unknown>> = await qr.query(
      `SELECT
         COUNT(od.id) AS totalDeliveryRows,
         COUNT(DISTINCT od.delivery_target) AS uniqueTargetCnt,
         SUM(CASE WHEN od.status = '${S.COMPLETE}' THEN 1 ELSE 0 END) AS completeCnt,
         SUM(CASE WHEN od.status = '${S.COMPLETE_SMS}' THEN 1 ELSE 0 END) AS completeSmsCnt,
         SUM(CASE WHEN od.status = '${S.FAIL}' THEN 1 ELSE 0 END) AS failCnt,
         SUM(CASE WHEN od.status = '${S.FAIL_SMS}' THEN 1 ELSE 0 END) AS failSmsCnt,
         SUM(CASE WHEN od.status IN ('${S.TEMP}','${S.WAIT}') THEN 1 ELSE 0 END) AS pendingCnt,
         SUM(CASE WHEN od.status NOT IN ('${S.COMPLETE}','${S.COMPLETE_SMS}','${S.FAIL}','${S.FAIL_SMS}','${S.TEMP}','${S.WAIT}') THEN 1 ELSE 0 END) AS otherCnt,
         SUM(CASE WHEN od.actual_send_at IS NOT NULL THEN 1 ELSE 0 END) AS sentCnt,
         SUM(CASE WHEN od.resend_at IS NOT NULL THEN 1 ELSE 0 END) AS resentCnt,
         SUM(CASE WHEN od.replaced_from_id IS NOT NULL THEN 1 ELSE 0 END) AS replacedCnt
       ${OrderService.AUDIT_BASE_WHERE}`,
      [orderId],
    );
    const r = rows[0] ?? {};
    return {
      totalDeliveryRows: Number(r.totalDeliveryRows ?? 0),
      uniqueTargetCnt: Number(r.uniqueTargetCnt ?? 0),
      completeCnt: Number(r.completeCnt ?? 0),
      completeSmsCnt: Number(r.completeSmsCnt ?? 0),
      failCnt: Number(r.failCnt ?? 0),
      failSmsCnt: Number(r.failSmsCnt ?? 0),
      pendingCnt: Number(r.pendingCnt ?? 0),
      otherCnt: Number(r.otherCnt ?? 0),
      sentCnt: Number(r.sentCnt ?? 0),
      resentCnt: Number(r.resentCnt ?? 0),
      replacedCnt: Number(r.replacedCnt ?? 0),
    };
  }

  private async fetchAuditDailyStats(qr: QueryRunner, orderId: number): Promise<OrderDeliveryAuditDailyDto[]> {
    const rows: Array<Record<string, unknown>> = await qr.query(
      `SELECT
         DATE_FORMAT(od.actual_send_at, '%Y-%m-%d') AS sendDate,
         COUNT(*) AS sendCnt,
         COUNT(DISTINCT od.delivery_target) AS uniquePhoneCnt,
         SUM(CASE WHEN od.resend_at IS NOT NULL THEN 1 ELSE 0 END) AS resentCnt
       ${OrderService.AUDIT_BASE_WHERE}
         AND od.actual_send_at IS NOT NULL
       GROUP BY DATE_FORMAT(od.actual_send_at, '%Y-%m-%d')
       ORDER BY sendDate ASC`,
      [orderId],
    );
    return rows.map((r) => {
      const sendCnt = Number(r.sendCnt ?? 0);
      const uniquePhoneCnt = Number(r.uniquePhoneCnt ?? 0);
      const resentCnt = Number(r.resentCnt ?? 0);
      return {
        sendDate: String(r.sendDate ?? ''),
        sendCnt,
        uniquePhoneCnt,
        resentCnt,
        isSuspicious: sendCnt - resentCnt > uniquePhoneCnt,
      };
    });
  }

  private async fetchAuditDuplicates(qr: QueryRunner, orderId: number): Promise<OrderDeliveryAuditDuplicateDto[]> {
    const rows: Array<Record<string, unknown>> = await qr.query(
      `SELECT
         od.delivery_target AS deliveryTarget,
         COUNT(*) AS rowCnt,
         SUM(CASE WHEN od.actual_send_at IS NOT NULL THEN 1 ELSE 0 END) AS sentCnt,
         GROUP_CONCAT(od.id ORDER BY od.id) AS deliveryIds,
         GROUP_CONCAT(od.status ORDER BY od.id) AS statuses,
         GROUP_CONCAT(IFNULL(DATE_FORMAT(od.actual_send_at, '%Y-%m-%d %H:%i:%s'), '') ORDER BY od.id) AS sendTimes,
         GROUP_CONCAT(IFNULL(DATE_FORMAT(od.resend_at, '%Y-%m-%d %H:%i:%s'), '') ORDER BY od.id) AS resendTimes,
         GROUP_CONCAT(IFNULL(od.replaced_from_id, 'NULL') ORDER BY od.id) AS replacedFromIds
       ${OrderService.AUDIT_BASE_WHERE}
       GROUP BY od.delivery_target
       HAVING COUNT(*) >= 2
       ORDER BY rowCnt DESC`,
      [orderId],
    );
    return rows.map((r) => {
      const replacedFromIds = this.parseNullableIdList(r.replacedFromIds);
      const encryptedTarget = String(r.deliveryTarget ?? '');
      return {
        deliveryTarget: this.cryptoCipher.safeDecryptDeliveryTarget(encryptedTarget) ?? encryptedTarget,
        rowCnt: Number(r.rowCnt ?? 0),
        sentCnt: Number(r.sentCnt ?? 0),
        deliveryIds: this.parseIdList(r.deliveryIds),
        statuses: String(r.statuses ?? '')
          .split(',')
          .filter((x) => x !== ''),
        sendTimes: this.parseNullableStringList(r.sendTimes),
        resendTimes: this.parseNullableStringList(r.resendTimes),
        replacedFromIds,
        // replacedFromId 가 하나라도 채워져 있으면 "폐기 후 신규 발송" 정상 케이스
        isLegitimate: replacedFromIds.some((v) => v !== null),
      };
    });
  }

  private async fetchSsgDuplicates(qr: QueryRunner, orderId: number): Promise<OrderDeliverySsgDuplicateDto[]> {
    return [
      ...(await this.fetchSsgColumnDuplicates(qr, orderId, 'ssg_transaction_id', 'ssgTransactionId')),
      ...(await this.fetchSsgColumnDuplicates(qr, orderId, 'bar_code', 'barCode')),
    ];
  }

  private async fetchSsgColumnDuplicates(
    qr: QueryRunner,
    orderId: number,
    column: 'ssg_transaction_id' | 'bar_code',
    field: 'ssgTransactionId' | 'barCode',
  ): Promise<OrderDeliverySsgDuplicateDto[]> {
    const rows: Array<Record<string, unknown>> = await qr.query(
      `SELECT
         od.${column} AS value,
         COUNT(*) AS cnt,
         GROUP_CONCAT(od.id ORDER BY od.id) AS deliveryIds
       ${OrderService.AUDIT_BASE_WHERE}
         AND od.${column} IS NOT NULL
       GROUP BY od.${column}
       HAVING COUNT(*) >= 2`,
      [orderId],
    );
    return rows.map((r) => ({
      field,
      value: String(r.value ?? ''),
      cnt: Number(r.cnt ?? 0),
      deliveryIds: this.parseIdList(r.deliveryIds),
    }));
  }

  // 이벤트 불러오기 전용 메서드 (수신자 정보 제외)
  async getEventDetail(user: ILoginUserInfo, getParam: OrderGetDetailReqParamDto): Promise<OrderGetDetailResDto> {
    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .withDeleted()
      .where('order.id = :id', { id: getParam.id });

    // IDOR 방지: 호출자의 조회 범위(view_scope)를 getDetail 과 동일하게 적용.
    const currentUser = await this.userRepository.findOne({
      where: { id: user.id },
      select: ['id', 'companyId', 'departmentId'],
    });
    const viewScope = await this.userViewScopeRepository.findOne({
      where: { userId: user.id },
    });
    queryBuilder = this.applyViewScopeFilter(queryBuilder, user, currentUser, viewScope);

    const order = await queryBuilder.getOne();

    if (!order) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    const productList: OrderDetailProductDto[] = [];

    await this.recoverDeletedProducts(order.orderProductMappings);

    let topImagePath;
    let midImagePath;

    if (order.orderProductMappings && order.orderProductMappings.length > 0) {
      for (const orderProductMapping of order.orderProductMappings) {
        // 발송 완료건: 저장된 expireAt 직접 사용, 미발송건: 기존 계산 유지
        const firstDelivery = orderProductMapping.orderDeliveries?.[0];
        const expireDate = firstDelivery?.expireAt
          ? dayjs(firstDelivery.expireAt).tz('Asia/Seoul').format('YYYY. MM. DD')
          : (() => {
              const expireDays = resolveExpireDays(
                orderProductMapping.galaxiaDuration ?? orderProductMapping.product?.galaxiaDuration,
                orderProductMapping.product?.expireDay ?? 0,
                orderProductMapping.product?.partnerCompany?.validityStartsNextDay,
              );
              return expireDays ? dayjs().tz('Asia/Seoul').add(expireDays, 'day').format('YYYY. MM. DD') : null;
            })();
        topImagePath = orderProductMapping.topImagePath ?? OrderService.DEFAULT_TOP_IMAGE_PATH;
        midImagePath = orderProductMapping.midImagePath ?? OrderService.DEFAULT_MID_IMAGE_PATH;

        const product = orderProductMapping.product
          ? {
              id: orderProductMapping.product.id,
              name: orderProductMapping.product.name,
              price: orderProductMapping.product.price,
              expireDay: orderProductMapping.product.expireDay,
              expireDate: expireDate,
              amount: orderProductMapping.amount,
              imagePath: orderProductMapping.product.imagePath,
              brandId: orderProductMapping.product.brandId,
              brandName: orderProductMapping.product.brand?.nameKorean ?? '',
            }
          : {
              id: orderProductMapping.productId,
              name: '(삭제된 상품)',
              price: 0,
              expireDay: 0,
              expireDate: null,
              amount: orderProductMapping.amount,
              imagePath: '',
              brandId: 0,
              brandName: '',
            };

        productList.push({
          id: orderProductMapping.id,
          product: product,
          orderDeliveryList: [], // 이벤트 불러오기 시 수신자 정보는 빈 배열

          emailSendType: orderProductMapping.emailSendType,
          emailFinalSendMethod: orderProductMapping.emailFinalSendMethod,
          fromEmail: orderProductMapping.fromEmail,
          fromPhoneNumber: orderProductMapping.fromPhoneNumber,
          requestToDestroyPersonalInfoDay: orderProductMapping.requestToDestroyPersonalInfoDay,
          sendContent: orderProductMapping.sendContent ?? '',
          sendMethod: orderProductMapping.sendMethod!,
          sendRequestAt: orderProductMapping.sendRequestAt
            ? format(orderProductMapping.sendRequestAt, DateFormatStr)
            : null,
          sendTailText: orderProductMapping.sendTailText,
          sendTitle: orderProductMapping.sendTitle ?? '',
          sendType: orderProductMapping.sendType,
          useEmailContent: orderProductMapping.useEmailContent,
          encourageDay: orderProductMapping.encourageDay,
          galaxiaDuration: orderProductMapping.galaxiaDuration,
          failCount: 0, // 이벤트 불러오기 시 발송 정보가 없으므로 0
          testDeliveryHistories: [],
        });
      }
    }

    let couponExpiration: number | null = null;
    if (order.type === IOrderType.SSG && productList.length > 0) {
      couponExpiration = productList[0].product?.expireDay ?? null;
    }

    const clientView = readClientUserView(order);
    const wallet = await this.walletAccountResolverService.resolveForOrder(order);

    return {
      id: order.id,
      registerAt: format(order.registerAt, DateFormatStr),
      eventName: order.eventName,
      type: order.type,
      topImagePath,
      midImagePath,
      status: order.status,
      couponExpiration: couponExpiration,
      productList: productList,
      settlePeriodCondition: order.user!.settlePeriodCondition,
      settlePeriodCount: order.user!.settlePeriodCount,
      isPreSettle: wallet.settleCondition === IUserSettleCondition.PRE_PAYMENT,
      cancelReason: order.cancelReason,
      canceledAt: order.canceledAt ? format(order.canceledAt, DateFormatStr) : null,
      totalFailCount: 0, // 이벤트 불러오기 시 발송 정보가 없으므로 0
      // 대행주문 관련 정보 (주문 시점 스냅샷 우선)
      clientUserId: order.clientUserId ?? null,
      clientUserName: clientView?.personName ?? null,
      clientCompanyName: clientView?.businessName ?? null,
      operationUserId: order.operationUserId ?? null,
      operationUserName: readOperationPersonName(order),
    };
  }

  private canUnmaskDeliveryTarget(unmasked: boolean | undefined, user: ILoginUserInfo): boolean {
    return (
      unmasked === true &&
      (user.authority === IUserAuthority.SUPER_ADMIN || user.authority === IUserAuthority.OPERATION_ADMIN)
    );
  }

  /**
   * 파기일을 특정할 수 없을 때 근거를 남긴다.
   *
   * 이 경로는 **사용자가 문서를 못 뽑는 지점**인데 지금껏 침묵했다. 배치·조기파기에는 각인
   * 건수 로그를 붙였으면서 정작 결과가 빈 칸이 되는 곳에 아무 신호가 없으면, 운영은 고객
   * 문의로만 알게 된다. 특히 '파기됐는데 시각 기록이 없는' 행은 데이터 결함이므로 반드시
   * 눈에 띄어야 한다 — 백필 누락이거나 배포 순서 사고다.
   */
  private warnUnresolvedDestroyAt(order: OrderEntity): void {
    const missingStamp = (order.orderProductMappings ?? [])
      .flatMap((m) => m.orderDeliveries ?? [])
      .filter((d) => d.deliveryTarget === '-' && !d.destroyedAt)
      .map((d) => d.id);
    const level = missingStamp.length > 0 ? 'error' : 'warn';
    this.logger[level](
      `[파기일] 주문 ${order.id} 의 파기일을 특정할 수 없어 null 로 응답 — ` +
        (missingStamp.length > 0
          ? `파기됐으나 destroyed_at 결측 orderDeliveryIds=[${missingStamp.join(', ')}] (백필 누락/배포순서 사고 의심)`
          : '발송요청일 또는 파기일수 결측(해당 행은 배치가 영원히 집지 않는다)'),
    );
  }

  /**
   * 고객 노출용 발송 목록 필터.
   *
   * '폐기 후 신규 발송'은 자사↔수신자 간 내부 처리(고객사는 알 필요 없음)이므로, 원본을 대체해
   * 신규 delivery(replacedFromId != null)를 숨기고 최초 발송 건만 남겨 논리적으로 1건으로 보이게 한다.
   * 적용: 발송상세(getDetail)·발송완료리포트(단일/다중)·(프론트가 이 목록으로 그리는) 파기확약서.
   * 전체 이력(원본+신규)은 CS 발송상세(customer_service)에서만 확인한다.
   */
  private hideDiscardReissueDeliveries(orderProductMappings: OrderProductMappingEntity[] | undefined): void {
    for (const opm of orderProductMappings ?? []) {
      if (opm.orderDeliveries) {
        opm.orderDeliveries = opm.orderDeliveries.filter((d) => d.replacedFromId === null);
      }
    }
  }

  async getDeliveryCompleteReport(
    getQuery: OrderGetDeliveryCompleteReportReqDto,
    user: ILoginUserInfo,
  ): Promise<OrderGetDeliveryCompleteReportResDto> {
    const canUnmask = this.canUnmaskDeliveryTarget(getQuery.unmasked, user);
    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .withDeleted()
      .where('order.id = :id', { id: getQuery.id })
      .addOrderBy('orderDeliveries.id', 'ASC');

    // IDOR 방지: 호출자의 조회 범위(view_scope)를 getDetail 과 동일하게 적용.
    const currentUser = await this.userRepository.findOne({
      where: { id: user.id },
      select: ['id', 'companyId', 'departmentId'],
    });
    const viewScope = await this.userViewScopeRepository.findOne({
      where: { userId: user.id },
    });
    queryBuilder = this.applyViewScopeFilter(queryBuilder, user, currentUser, viewScope);

    const order = await queryBuilder.getOne();

    if (!order) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    if (order.status !== IOrderStatus.DELIVERY_COMPLETE) {
      throw new BadRequestException('발송 완료된 건에 대해서만 조회 가능합니다.');
    }

    await this.recoverDeletedProducts(order.orderProductMappings);

    // ★ 파기예정일은 hideDiscardReissueDeliveries **이전**에 계산해야 한다.
    //   그 함수는 opm.orderDeliveries 를 replacedFromId === null 로 덮어써 폐기후재발행 tip 을
    //   목록에서 지우는데, 정기파기 배치에는 replacedFromId 필터가 없어 tip 도 파기 대상이다.
    //   필터 후에 계산하면 tip 의 늦은 유효기간이 MAX 에서 누락돼 실제보다 이른 날짜를 고지하게
    //   된다(예: 원본 2031-01-02 / tip 2031-06-02 인데 2031-01-02 로 인쇄). tip 을 화면에서
    //   숨기는 것은 노출 정책이고, 파기일 산정에 포함하는 것은 사실 진술이라 축이 다르다.
    // 이미 파기된 건은 order_delivery.destroyed_at 실적을, 그 외는 예정일을 답한다.
    const effectiveDestroy = resolveOrderEffectiveDestroyAt(order);
    if (effectiveDestroy === null) this.warnUnresolvedDestroyAt(order);

    // '폐기 후 신규 발송' 신규 건 숨김 — 발송완료리포트도 최초 발송 1건만 집계
    this.hideDiscardReissueDeliveries(order.orderProductMappings);

    const productList: OrderPdfDetailProductDto[] = [];
    // 발송완료 리포트: 주문 시점 스냅샷 우선, NULL이면 clientUser ?? user FK로 fallback
    const billing = readBillingView(order);
    const billingUserId = order.clientUserId ?? order.userId;
    const userInfo: OrderCustomerViewDto = {
      id: billingUserId,
      userBusinessName: billing.businessName || null,
      userPersonPhoneNumber: billing.personPhoneNumber,
      userBusinessEmail: billing.email,
      userPersonName: billing.personName || null,
      documentCompanyType: billing.documentCompanyType,
    };
    const now = new Date();
    const today = format(now, 'yyMMdd');
    const fileName: string = `${billing.businessName}_발송완료리포트_${today}`;

    if (order.orderProductMappings && order.orderProductMappings.length > 0) {
      for (const orderProductMapping of order.orderProductMappings) {
        const orderDeliveryList: OrderDeliveryCompleteReportViewDto[] = [];

        // 발송완료 리포트: 저장된 expireAt 직접 사용
        const firstDelivery = orderProductMapping.orderDeliveries?.[0];
        const expireDate = firstDelivery?.expireAt
          ? dayjs(firstDelivery.expireAt).tz('Asia/Seoul').format('YYYY. MM. DD')
          : null;

        const lineView = readLineProductView(orderProductMapping);
        // 취소된 발송건은 리포트에서 제외한다(197-16). 근거는 isDeliveryInCompleteReport docstring 참조.
        for (const orderDelivery of orderProductMapping.orderDeliveries.filter(isDeliveryInCompleteReport)) {
          // deliveryTarget 복호화 후 마스킹 처리 (originalDeliveryTarget 우선 사용)
          const targetToDecrypt = orderDelivery.originalDeliveryTarget || orderDelivery.deliveryTarget;
          const decryptedDeliveryTarget = this.cryptoCipher.safeDecryptDeliveryTarget(targetToDecrypt) ?? '';

          // 파기('-')는 마스킹하지 않고 그대로, canUnmask=true면 원문 유지
          let finalDeliveryTarget = decryptedDeliveryTarget;
          if (decryptedDeliveryTarget !== '-' && !canUnmask) {
            if (orderProductMapping.sendMethod === 'EMAIL') {
              finalDeliveryTarget = MaskingUtil.maskEmail(decryptedDeliveryTarget);
            } else {
              finalDeliveryTarget = MaskingUtil.maskBarCode(decryptedDeliveryTarget);
            }
          }

          // 초이스 쿠폰은 고객사 전달용 리포트에서 핀코드/쿠폰번호를 노출하지 않는다.
          const isChoiceProduct = orderProductMapping.product?.type === IProductType.CHOICE;
          const maskedBarCode =
            !isChoiceProduct && orderDelivery.barCode ? MaskingUtil.maskBarCode(orderDelivery.barCode) : null;
          orderDeliveryList.push({
            id: orderDelivery.id,
            sendRequestAt: orderDelivery.sendRequestAt ? format(orderDelivery.sendRequestAt, DateFormatStr) : null,
            actualSendAt: orderDelivery.actualSendAt ? format(orderDelivery.actualSendAt, DateFormatStr) : null,
            productName: lineView.name,
            amount: lineView.price,
            barCode: maskedBarCode,
            deliveryMethod: orderDelivery.deliveryMethod,
            deliveryTarget: finalDeliveryTarget,
          });
        }

        const product = {
          id: orderProductMapping.product?.id ?? orderProductMapping.productId,
          name: lineView.name,
          price: lineView.price,
          expireDay: lineView.expireDay,
          amount: orderProductMapping.amount,
          expireDate: expireDate,
          imagePath: lineView.imagePath ?? '',
          brandId: orderProductMapping.product?.brandId ?? 0,
          brandName: lineView.brandName,
        };
        productList.push({
          id: orderProductMapping.id,
          product: product,
          orderDeliveryList: orderDeliveryList,
          sendTitle: orderProductMapping.sendTitle ?? null,
          sendContent: orderProductMapping.sendContent ?? null,
        });
      }
    }

    let couponExpiration: number | null = null;
    if (order.type === IOrderType.SSG && productList.length > 0) {
      couponExpiration = productList[0].product?.expireDay ?? null;
    }

    // 첫 번째 상품의 정보 사용
    const firstMapping = order.orderProductMappings?.[0];

    // 실제 발송 시간 추출 (모든 상품 중 가장 늦은 날짜 사용)
    let latestActualSendAt: Date | null = null;
    for (const mapping of order.orderProductMappings || []) {
      if (mapping.orderDeliveries) {
        for (const delivery of mapping.orderDeliveries) {
          if (delivery.actualSendAt) {
            const sendDate = new Date(delivery.actualSendAt);
            if (!latestActualSendAt || sendDate > latestActualSendAt) {
              latestActualSendAt = sendDate;
            }
          }
        }
      }
    }
    const actualSendAt = latestActualSendAt ? format(latestActualSendAt, DateFormatStr) : null;

    // 상품별 발송정보 목록 생성
    const sendInfoList: { productName: string; sendTitle: string | null; sendContent: string | null }[] = [];
    for (const mapping of order.orderProductMappings || []) {
      sendInfoList.push({
        productName: readLineProductView(mapping).name,
        sendTitle: mapping.sendTitle ?? null,
        sendContent: mapping.sendContent ?? null,
      });
    }

    return {
      id: order.id,
      fileName,
      userInfo,
      registerAt: format(order.registerAt, DateFormatStr),
      eventName: order.eventName,
      type: order.type,
      status: order.status,
      couponExpiration: couponExpiration,
      requestToDestroyPersonalInfoDay: firstMapping?.requestToDestroyPersonalInfoDay ?? 0,
      // 실효 파기예정일 — 유효기간 가드로 파기가 미뤄지는 건까지 반영한 '배치가 파기할 수 있는
      // 가장 이른 날'. 보고서 PDF 가 orderProductMapping.sendRequestAt + N일로 자체 계산하던 것을
      // 대신할 값으로 **추가**한다(기존 requestToDestroyPersonalInfoDay 는 그대로 두므로, 실제
      // 교체는 프론트가 이 필드를 쓰기 시작할 때 일어난다).
      // 값은 tip 포함 집합으로 미리 계산해 둔 것이다.
      //
      // ★ 계산 불가 시 null 이고, **프론트는 그때 자체 계산으로 폴백하면 안 된다**(계약 변경).
      //   종전에는 "null 이면 프론트가 발송일+파기일수로 폴백"을 합의사항으로 뒀는데, 그 식이
      //   바로 이 필드를 만들게 한 오류의 원인이다. 서버가 정직하게 "모른다"고 답한 자리를
      //   클라이언트가 추측으로 메우면, 백엔드가 정직해진 만큼 정확히 그만큼 프론트가 거짓말한다.
      //   그 값이 파기확인서(대외 증빙)에 실리므로 허용할 수 없다.
      //   → null 이면 빈 칸/"확인 필요"로 표시하도록 DTO 설명에 명시했고, 프론트 요청서에도
      //     반영했다. 다만 **이 레포가 강제하지는 못한다** — 프론트 구현을 확인해야 완결된다.
      //
      // ⚠️ 폴백을 금지하는 또 다른 이유: 폴백이 쓰는 requestToDestroyPersonalInfoDay 는
      // firstMapping 대표값인데 effectiveDestroyAt 은 전 매핑 MAX 라, 상품별 파기일수가 다른
      // 다상품 주문에서는 두 경로가 애초에 다른 날짜를 낸다. 기존 필드의 의미를 바꾸면 파기일수
      // 편집 API(order.controller.ts 상품매핑 개인정보파기일 변경)와 충돌하므로 값은 그대로 두고
      // DTO 설명에 대표값임을 명시했다.
      effectiveDestroyAt: effectiveDestroy ? format(effectiveDestroy.at, DateDateFormatStr) : null,
      effectiveDestroyAtKind: effectiveDestroy?.kind ?? null,
      productList: productList,
      actualSendAt: actualSendAt,
      // 발송 정보 추가 (첫 번째 상품의 정보 사용)
      sendMethod: firstMapping?.sendMethod ?? null,
      sendTitle: firstMapping?.sendTitle ?? null,
      sendContent: firstMapping?.sendContent ?? null,
      sendRequestAt: firstMapping?.sendRequestAt ? format(firstMapping.sendRequestAt, DateFormatStr) : null,
      fromPhoneNumber: firstMapping?.fromPhoneNumber ?? null,
      fromEmail: firstMapping?.fromEmail ?? null,
      encourageDay: firstMapping?.encourageDay ?? null,
      sendInfoList,
    };
  }

  async deliveryCompleteReportPdf(
    getBody: OrderGetDeliveryCompleteReportPdfReqDto,
    user: ILoginUserInfo,
    ipAddress: string,
  ): Promise<void> {
    // IDOR 방지: develop(#43)이 도입한 findDeliveryCompleteOrderInViewScope 를 쓴다.
    // 이 브랜치도 같은 구멍을 독립적으로 막고 있었으나(assertReportPdfWritable), 그쪽이
    // view_scope + 발송완료 상태까지 함께 보는 상위 집합이라 그쪽으로 통일한다.
    //
    // ⚠️ 다만 그쪽은 권한 면제가 없다 — 운영 실측 근거는 §D 커밋 메시지와 PR 본문 참조.
    const order = await this.findDeliveryCompleteOrderInViewScope(user, getBody.id);

    // 컬럼과 activity_log 가 같은 값을 쓰도록 한 번만 확정한다. 각자 계산하면 source 미전송 시
    // 컬럼은 DOCUMENT, 로그는 undefined 가 되어 같은 발행 사건의 두 기록이 어긋난다
    // (이력 조회의 '발행경로'가 빈칸으로 나오고, 프론트는 레거시 null 행과 구별하지 못한다).
    const resolvedSource = getBody.source || IReportSource.DOCUMENT;

    order.deliveryCompleteReportCount++;
    order.deliveryReportLastSource = resolvedSource;

    await this.orderRepository.save(order);

    // activity_log에 기록
    await this.activityLogService.createLog({
      userId: user.id,
      userEmail: user.email,
      method: 'POST',
      requestUrl: '/order/delivery-complete/report/pdf',
      actionType: 'DELIVERY_COMPLETE_REPORT',
      ipAddress,
      statusCode: 200,
      result: ActivityLogResult.SUCCESS,
      responseTime: 0,
      requestParams: { orderId: getBody.id, source: resolvedSource, unmasked: getBody.unmasked === true },
    });

    return;
  }

  async getOrderCompleteReport(
    getQuery: OrderGetOrderCompleteReportReqDto,
    user: ILoginUserInfo,
  ): Promise<OrderGetOrderCompleteReportResDto> {
    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .withDeleted()
      .where('order.id = :id', { id: getQuery.id });

    // IDOR 방지: 호출자의 조회 범위(view_scope)를 getDetail 과 동일하게 적용.
    const currentUser = await this.userRepository.findOne({
      where: { id: user.id },
      select: ['id', 'companyId', 'departmentId'],
    });
    const viewScope = await this.userViewScopeRepository.findOne({
      where: { userId: user.id },
    });
    queryBuilder = this.applyViewScopeFilter(queryBuilder, user, currentUser, viewScope);

    const order = await queryBuilder.getOne();

    if (!order) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    if (order.status !== IOrderStatus.DELIVERY_COMPLETE) {
      throw new BadRequestException('발송 완료된 건에 대해서만 조회 가능합니다.');
    }

    const serialNumber: string = `${format(order.createdAt, DateDateFormatStr)}-${order.id}`;
    const fileName: string = `${serialNumber}_거래명세서`;
    const orderDeliveryList: OrderCompleteReportDeliveryViewDto[] = [];

    // 카드할증(3%)은 거래명세서 총액에 포함하지 않는다(의도된 동작).
    //   - price/totalAmount 는 물품(상품권) 공급가액 기준(applyCardSurcharge 미적용).
    //   - 카드 정산 주문의 실제 청구액(order.settleAmount)은 여기에 카드할증이 더해진 값이지만,
    //     카드할증은 물품 공급가가 아닌 결제수단 수수료이므로 별도 결제 영수증으로 첨부해 안내한다.
    //   - vat 은 상품권 특성상 0(면세)로 고정.
    let price = 0;
    const vat = 0;
    let totalAmount = 0;

    if (order.orderProductMappings && order.orderProductMappings.length > 0) {
      for (const orderProductMapping of order.orderProductMappings) {
        // 품목별 일자: 첫 번째 orderDelivery 의 발송 시각 사용
        const firstDelivery = orderProductMapping.orderDeliveries?.[0];
        const itemSendRequestAt = firstDelivery?.sendRequestAt
          ? format(firstDelivery.sendRequestAt, DateFormatStr)
          : null;

        const rows = buildOrderCompleteReportRows(orderProductMapping, itemSendRequestAt);
        orderDeliveryList.push(...rows);
        price += rows.reduce((sum, row) => sum + row.price, 0);
      }

      totalAmount = price + vat;
    }

    // 첫 번째 상품의 발송 요청 시간 사용
    const firstMapping = order.orderProductMappings?.[0];
    const sendRequestAt =
      firstMapping && normalizeDate(firstMapping.sendRequestAt)
        ? format(firstMapping.sendRequestAt!, DateFormatStr)
        : null;

    // 거래명세서: 주문 시점 스냅샷 우선, NULL이면 clientUser ?? user FK로 fallback
    const billing = readBillingView(order);

    return {
      fileName,
      serialNumber,
      userSettleCondition: billing.settleCondition,
      businessName: billing.businessName,
      businessNumber: billing.businessNumber,
      personName: billing.personName,
      businessAddress: billing.businessAddress,
      businessType: billing.industryType,
      businessItem: billing.industryItem,
      eventName: order.eventName,
      sendRequestAt: sendRequestAt ?? null,
      price,
      vat,
      totalAmount,
      documentCompanyType: billing.documentCompanyType,
      orderDeliveryList,
    };
  }

  async orderCompleteReportPdf(
    getBody: OrderGetOrderCompleteReportPdfReqDto,
    user: ILoginUserInfo,
    ipAddress: string,
  ): Promise<void> {
    // IDOR 방지 — 발송완료리포트 경로와 동일. 상세는 그쪽 주석 참조.
    const order = await this.findDeliveryCompleteOrderInViewScope(user, getBody.id);

    // 컬럼/로그 단일 확정 — 발송완료리포트 경로와 동일한 이유.
    const resolvedSource = getBody.source || IReportSource.DOCUMENT;

    order.orderCompleteReportCount++;
    order.transactionStatementLastSource = resolvedSource;

    await this.orderRepository.save(order);

    // activity_log에 기록
    await this.activityLogService.createLog({
      userId: user.id,
      userEmail: user.email,
      method: 'POST',
      requestUrl: '/order/order-complete/report/pdf',
      actionType: 'TRANSACTION_STATEMENT',
      ipAddress,
      statusCode: 200,
      result: ActivityLogResult.SUCCESS,
      responseTime: 0,
      requestParams: { orderId: getBody.id, source: resolvedSource },
    });

    return;
  }

  async destructionCertificatePdf(
    getBody: OrderGetDestructionCertificatePdfReqDto,
    user: ILoginUserInfo,
    ipAddress: string,
  ): Promise<void> {
    await this.assertDestructionCertificateIssuable(getBody.id, user);

    // activity_log에 기록
    await this.activityLogService.createLog({
      userId: user.id,
      userEmail: user.email,
      method: 'POST',
      requestUrl: '/order/destruction-certificate/pdf',
      actionType: 'DESTRUCTION_CERTIFICATE',
      ipAddress,
      statusCode: 200,
      result: ActivityLogResult.SUCCESS,
      responseTime: 0,
      requestParams: { orderId: getBody.id },
    });

    return;
  }

  /**
   * 다중 주문 발송완료 리포트 조회 (통합)
   */
  async getDeliveryCompleteReportMultiple(
    ids: string,
    evidenceDate: string | undefined,
    user: ILoginUserInfo,
    unmasked: boolean,
  ): Promise<any> {
    const canUnmask = this.canUnmaskDeliveryTarget(unmasked, user);
    const orderIds = ids.split(',').map((id) => parseInt(id.trim(), 10));
    // 증빙일자가 있으면 파싱
    const evidenceDateParsed = evidenceDate ? new Date(evidenceDate) : null;

    if (orderIds.length === 0) {
      throw new BadRequestException('주문 ID가 필요합니다.');
    }

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .withDeleted()
      .where('order.id IN (:...ids)', { ids: orderIds })
      .addOrderBy('orderDeliveries.id', 'ASC');

    // IDOR 방지: 호출자 조회 범위(view_scope) 밖 주문은 결과에서 제외 → 타사 주문 통합증빙 차단.
    const currentUser = await this.userRepository.findOne({
      where: { id: user.id },
      select: ['id', 'companyId', 'departmentId'],
    });
    const viewScope = await this.userViewScopeRepository.findOne({
      where: { userId: user.id },
    });
    queryBuilder = this.applyViewScopeFilter(queryBuilder, user, currentUser, viewScope);

    const orders = await queryBuilder.getMany();

    if (orders.length === 0) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    // IDOR/정합성: 요청 id 중 조회범위 밖·부재로 빠진 건이 있으면 부분 생성 금지(전부-또는-전무).
    // (응답 orderIds 는 요청 원본을 그대로 반환하므로, 일부만 조회되면 증빙/일련번호 불일치 발생)
    const foundIds = new Set(orders.map((order) => order.id));
    const missingIds = orderIds.filter((id) => !foundIds.has(id));
    if (missingIds.length > 0) {
      throw new BadRequestException('조회 권한이 없거나 존재하지 않는 주문이 포함되어 있습니다.');
    }

    // 모든 주문이 발송 완료 상태인지 확인
    for (const order of orders) {
      if (order.status !== IOrderStatus.DELIVERY_COMPLETE) {
        throw new BadRequestException('발송 완료된 건에 대해서만 조회 가능합니다.');
      }
    }

    // ★ 단일 보고서(:1638)와 같은 이유로 hideDiscardReissueDeliveries **이전**에 계산한다.
    //   통합 보고서는 주문이 N개이므로 집계 규칙을 한 단계 더 얹는다 — 전 주문 파기일의 MAX 이고,
    //   하나라도 특정 불가(null)면 전체가 null 이다. 문서 한 장이 여러 주문을 덮으므로 "이 날이면
    //   전부 지워져 있다"가 성립하려면 가장 늦은 날이어야 한다.
    let multipleEffectiveDestroyAt: Date | null = null;
    // kind 도 '가장 약한 것'으로 모은다 — 문서 한 장이 여러 주문을 덮으므로, 그중 하나라도
    // 추정이면 그 문서 전체를 추정으로 봐야 한다(주문 단위 집계와 같은 논리).
    let multipleKind: EffectiveDestroyAtKind | null = null;
    for (const order of orders) {
      const resolved = resolveOrderEffectiveDestroyAt(order);
      if (resolved === null) {
        this.warnUnresolvedDestroyAt(order);
        multipleEffectiveDestroyAt = null;
        multipleKind = null;
        break;
      }
      const destroyAt = resolved.at;
      if (multipleKind === null || KIND_CERTAINTY[resolved.kind] < KIND_CERTAINTY[multipleKind])
        multipleKind = resolved.kind;
      if (multipleEffectiveDestroyAt === null || destroyAt > multipleEffectiveDestroyAt) {
        multipleEffectiveDestroyAt = destroyAt;
      }
    }

    // '폐기 후 신규 발송' 신규 건 숨김 — 통합 발송완료리포트도 최초 발송 1건만 집계
    for (const order of orders) {
      this.hideDiscardReissueDeliveries(order.orderProductMappings);
    }

    // 모든 주문이 같은 과금 대상 회사 소속인지 확인 (다중 주문 증빙 발행 시)
    if (orders.length > 1) {
      const getBillingCompanyId = (order: OrderEntity) => {
        const billingUser = order.clientUser ?? order.user;
        return billingUser?.companyId;
      };
      const firstCompanyId = getBillingCompanyId(orders[0]);
      const allSameCompany = orders.every((order) => getBillingCompanyId(order) === firstCompanyId);
      if (!allSameCompany) {
        throw new BadRequestException('서로 다른 회사의 주문은 합쳐서 증빙 발행할 수 없습니다.');
      }
    }

    // 첫 번째 주문 기준으로 기본 정보 설정 (주문 시점 스냅샷 우선)
    const firstOrder = orders[0];
    const billing = readBillingView(firstOrder);
    const billingUserId = firstOrder.clientUserId ?? firstOrder.userId;
    const userInfo: OrderCustomerViewDto = {
      id: billingUserId,
      userBusinessName: billing.businessName || null,
      userPersonPhoneNumber: billing.personPhoneNumber,
      userBusinessEmail: billing.email,
      userPersonName: billing.personName || null,
      documentCompanyType: billing.documentCompanyType,
    };

    const now = new Date();
    const today = format(now, 'yyMMdd');
    const fileName: string = `${billing.businessName}_발송완료리포트_${today}`;

    // 이벤트명 통합 (여러 개면 "a 외 n건" 형식)
    const eventNames = [...new Set(orders.map((o) => o.eventName))];
    const eventName = eventNames.length > 1 ? `${eventNames[0]} 외 ${eventNames.length - 1}건` : eventNames[0];

    // 모든 주문의 상품 목록 통합
    const productList: OrderPdfDetailProductDto[] = [];
    let firstMapping: any = null;
    let actualSendAt: string | null = null;
    const allMappings: any[] = [];

    for (const order of orders) {
      if (order.orderProductMappings && order.orderProductMappings.length > 0) {
        for (const orderProductMapping of order.orderProductMappings) {
          if (!firstMapping) {
            firstMapping = orderProductMapping;
          }
          allMappings.push(orderProductMapping);

          const orderDeliveryList: OrderDeliveryCompleteReportViewDto[] = [];

          // 발송완료 리포트 (엑셀): 저장된 expireAt 직접 사용
          const firstDelivery = orderProductMapping.orderDeliveries?.[0];
          const expireDate = firstDelivery?.expireAt
            ? dayjs(firstDelivery.expireAt).tz('Asia/Seoul').format('YYYY. MM. DD')
            : null;

          const lineView = readLineProductView(orderProductMapping);
          // 취소된 발송건은 리포트에서 제외한다(197-16). 근거는 isDeliveryInCompleteReport docstring 참조.
          for (const orderDelivery of orderProductMapping.orderDeliveries.filter(isDeliveryInCompleteReport)) {
            // deliveryTarget 복호화 후 마스킹 처리 (originalDeliveryTarget 우선 사용)
            const targetToDecrypt = orderDelivery.originalDeliveryTarget || orderDelivery.deliveryTarget;
            const decryptedDeliveryTarget = this.cryptoCipher.safeDecryptDeliveryTarget(targetToDecrypt) ?? '';

            let finalDeliveryTarget = decryptedDeliveryTarget;
            if (decryptedDeliveryTarget !== '-' && !canUnmask) {
              if (orderProductMapping.sendMethod === 'EMAIL') {
                finalDeliveryTarget = MaskingUtil.maskEmail(decryptedDeliveryTarget);
              } else {
                finalDeliveryTarget = MaskingUtil.maskBarCode(decryptedDeliveryTarget);
              }
            }

            // 실제 발송 시간 추출 (증빙일자가 있으면 증빙일자 사용)
            if (!actualSendAt) {
              if (evidenceDateParsed) {
                actualSendAt = format(evidenceDateParsed, DateFormatStr);
              } else if (orderDelivery.actualSendAt) {
                actualSendAt = format(orderDelivery.actualSendAt, DateFormatStr);
              }
            }

            // 발송날짜: 증빙일자가 있으면 증빙일자 사용, 없으면 실발송일 사용
            const deliverySendRequestAt = evidenceDateParsed
              ? format(evidenceDateParsed, DateFormatStr)
              : orderDelivery.actualSendAt
                ? format(orderDelivery.actualSendAt, DateFormatStr)
                : null;

            // 초이스 쿠폰은 고객사 전달용 리포트에서 핀코드/쿠폰번호를 노출하지 않는다.
            const isChoiceProduct = orderProductMapping.product?.type === IProductType.CHOICE;
            const maskedBarCode =
              !isChoiceProduct && orderDelivery.barCode ? MaskingUtil.maskBarCode(orderDelivery.barCode) : null;
            orderDeliveryList.push({
              id: orderDelivery.id,
              sendRequestAt: deliverySendRequestAt,
              actualSendAt: orderDelivery.actualSendAt ? format(orderDelivery.actualSendAt, DateFormatStr) : null,
              productName: lineView.name,
              amount: lineView.price,
              barCode: maskedBarCode,
              deliveryMethod: orderDelivery.deliveryMethod,
              deliveryTarget: finalDeliveryTarget,
            });
          }

          const product = {
            id: orderProductMapping.product?.id ?? orderProductMapping.productId,
            name: lineView.name,
            price: lineView.price,
            expireDay: lineView.expireDay,
            amount: orderProductMapping.amount,
            expireDate: expireDate,
            imagePath: lineView.imagePath ?? '',
            brandId: orderProductMapping.product?.brandId ?? 0,
            brandName: lineView.brandName,
          };

          productList.push({
            id: orderProductMapping.id,
            product: product,
            orderDeliveryList: orderDeliveryList,
            sendTitle: orderProductMapping.sendTitle ?? null,
            sendContent: orderProductMapping.sendContent ?? null,
          });
        }
      }
    }

    let couponExpiration: number | null = null;
    if (firstOrder.type === IOrderType.SSG && productList.length > 0) {
      couponExpiration = productList[0].product?.expireDay ?? null;
    }

    // 상품별 발송정보 목록 (단일 빌더와 동일 계약 — 무조건 "외" 병합 대신 상품별 구분 제공)
    const sendInfoList: { productName: string; sendTitle: string | null; sendContent: string | null }[] =
      allMappings.map((mapping) => ({
        productName: readLineProductView(mapping).name,
        sendTitle: mapping.sendTitle ?? null,
        sendContent: mapping.sendContent ?? null,
      }));

    return {
      id: firstOrder.id,
      orderIds: orderIds,
      fileName,
      userInfo,
      registerAt: format(firstOrder.registerAt, DateFormatStr),
      eventName: eventName,
      type: firstOrder.type,
      status: firstOrder.status,
      couponExpiration: couponExpiration,
      requestToDestroyPersonalInfoDay: firstMapping?.requestToDestroyPersonalInfoDay ?? 0,
      // 전 주문 파기일의 MAX(아래 루프에서 tip 포함 집합으로 계산). 단일 보고서와 같은 formatter 가
      // 그리므로 이 필드가 빠지면 같은 주문을 단일로 뽑을 때와 통합으로 뽑을 때 날짜가 달라진다.
      effectiveDestroyAt: multipleEffectiveDestroyAt ? format(multipleEffectiveDestroyAt, DateDateFormatStr) : null,
      effectiveDestroyAtKind: multipleEffectiveDestroyAt ? multipleKind : null,
      productList: productList,
      actualSendAt: actualSendAt,
      sendMethod: firstMapping?.sendMethod ?? null,
      // 발송 제목 통합 (여러 개면 "제목 외" 형식)
      sendTitle: allMappings.length > 1 ? `${firstMapping?.sendTitle ?? ''} 외` : (firstMapping?.sendTitle ?? null),
      // 발송 내용 통합 (여러 개면 "내용\n\n외" 형식)
      sendContent:
        allMappings.length > 1 ? `${firstMapping?.sendContent ?? ''}\n\n외` : (firstMapping?.sendContent ?? null),
      sendRequestAt: firstMapping?.sendRequestAt ? format(firstMapping.sendRequestAt, DateFormatStr) : null,
      fromPhoneNumber: firstMapping?.fromPhoneNumber ?? null,
      fromEmail: firstMapping?.fromEmail ?? null,
      encourageDay: firstMapping?.encourageDay ?? null,
      sendInfoList,
    };
  }

  /**
   * 다중 주문 거래명세서 조회 (통합)
   */
  async getOrderCompleteReportMultiple(
    ids: string,
    evidenceDate: string | undefined,
    user: ILoginUserInfo,
  ): Promise<any> {
    const orderIds = ids.split(',').map((id) => parseInt(id.trim(), 10));
    // 증빙일자가 있으면 파싱
    const evidenceDateParsed = evidenceDate ? new Date(evidenceDate) : null;

    if (orderIds.length === 0) {
      throw new BadRequestException('주문 ID가 필요합니다.');
    }

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .withDeleted()
      .where('order.id IN (:...ids)', { ids: orderIds });

    // IDOR 방지: 호출자 조회 범위(view_scope) 밖 주문은 결과에서 제외 → 타사 주문 통합증빙 차단.
    const currentUser = await this.userRepository.findOne({
      where: { id: user.id },
      select: ['id', 'companyId', 'departmentId'],
    });
    const viewScope = await this.userViewScopeRepository.findOne({
      where: { userId: user.id },
    });
    queryBuilder = this.applyViewScopeFilter(queryBuilder, user, currentUser, viewScope);

    const orders = await queryBuilder.getMany();

    if (orders.length === 0) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    // IDOR/정합성: 요청 id 중 조회범위 밖·부재로 빠진 건이 있으면 부분 생성 금지(전부-또는-전무).
    // (응답 orderIds·일련번호가 요청 원본을 그대로 쓰므로, 일부만 조회되면 거래명세서 불일치 발생)
    const foundIds = new Set(orders.map((order) => order.id));
    const missingIds = orderIds.filter((id) => !foundIds.has(id));
    if (missingIds.length > 0) {
      throw new BadRequestException('조회 권한이 없거나 존재하지 않는 주문이 포함되어 있습니다.');
    }

    for (const order of orders) {
      if (order.status !== IOrderStatus.DELIVERY_COMPLETE) {
        throw new BadRequestException('발송 완료된 건에 대해서만 조회 가능합니다.');
      }
    }

    // 모든 주문이 같은 과금 대상 회사 소속인지 확인 (다중 주문 증빙 발행 시)
    if (orders.length > 1) {
      const getBillingCompanyId = (order: OrderEntity) => {
        const billingUser = order.clientUser ?? order.user;
        return billingUser?.companyId;
      };
      const firstCompanyId = getBillingCompanyId(orders[0]);
      const allSameCompany = orders.every((order) => getBillingCompanyId(order) === firstCompanyId);
      if (!allSameCompany) {
        throw new BadRequestException('서로 다른 회사의 주문은 합쳐서 증빙 발행할 수 없습니다.');
      }
    }

    const firstOrder = orders[0];
    // 일련번호: 증빙일자가 있으면 증빙일자 사용, 없으면 주문 생성일 사용
    const serialDateStr = evidenceDateParsed
      ? format(evidenceDateParsed, DateDateFormatStr)
      : format(firstOrder.createdAt, DateDateFormatStr);
    const serialNumber: string = `${serialDateStr}-${orderIds.join('_')}`;
    const fileName: string = `${serialNumber}_거래명세서`;

    // 이벤트명 통합
    const eventNames = [...new Set(orders.map((o) => o.eventName))];
    const eventName = eventNames.length > 1 ? `${eventNames[0]} 외 ${eventNames.length - 1}건` : eventNames[0];

    const orderDeliveryList: OrderCompleteReportDeliveryViewDto[] = [];
    // 카드할증(3%)은 거래명세서 총액에 포함하지 않는다(의도된 동작).
    //   - price/totalAmount 는 물품(상품권) 공급가액 기준(applyCardSurcharge 미적용).
    //   - 카드 정산 주문의 실제 청구액(order.settleAmount)은 여기에 카드할증이 더해진 값이지만,
    //     카드할증은 물품 공급가가 아닌 결제수단 수수료이므로 별도 결제 영수증으로 첨부해 안내한다.
    //   - vat 은 상품권 특성상 0(면세)로 고정.
    let price = 0;
    const vat = 0;
    let totalAmount = 0;
    // 거래일자: 증빙일자가 있으면 증빙일자 사용 (루프 불변값이므로 1회만 계산)
    const evidenceDateStr = evidenceDateParsed ? format(evidenceDateParsed, DateFormatStr) : null;
    let sendRequestAt: string | null = evidenceDateStr;

    for (const order of orders) {
      if (order.orderProductMappings && order.orderProductMappings.length > 0) {
        for (const orderProductMapping of order.orderProductMappings) {
          const firstDelivery = orderProductMapping.orderDeliveries?.[0];
          const deliveryDateStr = firstDelivery?.sendRequestAt
            ? format(firstDelivery.sendRequestAt, DateFormatStr)
            : null;

          // 증빙일자가 없고 sendRequestAt도 없으면 첫 배송의 발송요청일 사용
          if (!sendRequestAt && deliveryDateStr) {
            sendRequestAt = deliveryDateStr;
          }

          // 품목별 일자: 증빙일자가 있으면 증빙일자, 없으면 첫 배송의 발송요청일
          const itemSendRequestAt = evidenceDateStr ?? deliveryDateStr;

          const rows = buildOrderCompleteReportRows(orderProductMapping, itemSendRequestAt);
          orderDeliveryList.push(...rows);
          price += rows.reduce((sum, row) => sum + row.price, 0);
        }
      }
    }

    totalAmount = price + vat;

    // 다중 거래명세서: 첫 주문의 스냅샷 우선, NULL이면 clientUser ?? user FK로 fallback
    const billing = readBillingView(firstOrder);

    return {
      orderIds: orderIds,
      fileName,
      serialNumber,
      userSettleCondition: billing.settleCondition,
      businessName: billing.businessName,
      businessNumber: billing.businessNumber,
      personName: billing.personName,
      businessAddress: billing.businessAddress,
      businessType: billing.industryType,
      businessItem: billing.industryItem,
      eventName: eventName,
      sendRequestAt: sendRequestAt ?? null,
      price,
      vat,
      totalAmount,
      documentCompanyType: billing.documentCompanyType,
      orderDeliveryList,
    };
  }

  async getOrderSettle(getQuery: OrderGetSettleReqDto): Promise<OrderGetSettleGetListResDto> {
    const { id, page, take } = getQuery;

    const skip = (page - 1) * take;

    const order = await this.orderRepository.findOne({
      where: {
        id,
      },
    });

    if (!order) {
      throw new BadRequestException('not found order');
    }

    // 고객사 정산방법 조회 (과금 대상 유저 기준)
    const billingUserForSettle = await this.userRepository.findOne({
      where: { id: order.clientUserId ?? order.userId },
      relations: ['company'],
    });

    // 1. 유저의 주문 상품 조회 (classification 포함)
    // SSG 합산 할인 및 전체 합계 계산을 위해 페이지네이션 없이 전체 조회 후 resultList 생성 후 슬라이스
    const orderProductList = await this.orderProductMappingRepository.find({
      where: {
        orderId: id,
      },
      relations: ['product', 'product.brand', 'product.classification', 'orderDeliveries'],
    });
    const totalCount = orderProductList.length;

    // 2. 과금 대상 유저의 할인 옵션 조회 (대행주문인 경우 clientUser의 할인옵션 사용)
    const billingUserId = order.clientUserId ?? order.userId;
    const userDiscounts = (
      await this.userDiscountRepository.find({
        where: { userId: billingUserId },
      })
    ).filter((discount) => discount.userId === billingUserId);

    this.logger.debug(
      `[getOrderSettle] orderId=${id}, billingUserId=${billingUserId} (clientUserId=${order.clientUserId}, userId=${order.userId})`,
    );
    this.logger.debug(`[getOrderSettle] userDiscounts count=${userDiscounts.length}`);
    userDiscounts.forEach((d) => {
      this.logger.debug(
        `[getOrderSettle] discount: id=${d.id}, category=${d.category}, method=${d.method}, group=${d.group}, primaryCategory=${d.primaryCategory}, range=${d.range}, compareCondition=${d.compareCondition}, priceAdjustment=${d.priceAdjustment}, pricePercent=${d.pricePercent}, userId=${d.userId}, partnerCompanyId=${d.partnerCompanyId}`,
      );
    });

    // 발송 완료/확정 건은 UserDiscount 폴백 없이 매핑 저장값만 사용
    // (새로 등록된 할인조건이 이미 완료된 주문에 소급 적용되는 것을 방지)
    const isOrderCompleted =
      order.status === IOrderStatus.DELIVERY_CONFIRMED || order.status === IOrderStatus.DELIVERY_COMPLETE;

    // SSG 주문: 수신번호별 합산 할인 로직
    const isSsgOrder = order.type === IOrderType.SSG;
    let resultList: OrderSettleViewDto[] = [];
    let virtualTotalCount = 0;

    if (isSsgOrder) {
      // Phase 1: 수신번호별 총 금액 사전 계산 + phoneKey 캐싱 (복호화 1회만 수행)
      const phoneToTotalAmount = new Map<string, number>();
      const deliveryPhoneKeyCache = new Map<number, string>();
      for (const op of orderProductList) {
        const price = readLineProductView(op).price;
        for (const delivery of op.orderDeliveries ?? []) {
          const decrypted = this.cryptoCipher.safeDecryptDeliveryTarget(
            delivery.originalDeliveryTarget || delivery.deliveryTarget,
          );
          const key = decrypted !== null ? decrypted : `__null_${delivery.id}`;
          deliveryPhoneKeyCache.set(delivery.id, key);
          phoneToTotalAmount.set(key, (phoneToTotalAmount.get(key) ?? 0) + price);
        }
      }

      // Phase 2: 크로스 상품 수신번호 식별 (2개 이상 다른 상품이 가는 번호)
      const phoneProductIds = new Map<string, Set<number>>();
      for (const op of orderProductList) {
        for (const delivery of op.orderDeliveries ?? []) {
          const phoneKey = deliveryPhoneKeyCache.get(delivery.id)!;
          const ids = phoneProductIds.get(phoneKey) ?? new Set();
          ids.add(op.id);
          phoneProductIds.set(phoneKey, ids);
        }
      }
      const multiProductPhones = new Set(
        [...phoneProductIds.entries()].filter(([, ids]) => ids.size > 1).map(([phone]) => phone),
      );

      // Phase 3a: 단일 상품 수신번호 — 기존 로직 (상품 단가 × 수량 표시)
      for (const orderProduct of orderProductList) {
        const lineView3a = readLineProductView(orderProduct);
        const productPrice = lineView3a.price;
        const product = orderProduct.product;
        const deliveryMap = new Map((orderProduct.orderDeliveries ?? []).map((d) => [d.id, d]));

        // 크로스 상품 번호 제외한 delivery만 필터
        const singleDeliveries = (orderProduct.orderDeliveries ?? []).filter((d) => {
          const phoneKey = deliveryPhoneKeyCache.get(d.id)!;
          return !multiProductPhones.has(phoneKey);
        });
        if (singleDeliveries.length === 0) continue;

        // 수신번호별 그룹핑
        const targetGroups = new Map<string, typeof orderProduct.orderDeliveries>();
        for (const delivery of singleDeliveries) {
          const key = deliveryPhoneKeyCache.get(delivery.id) ?? `__null_${delivery.id}`;
          const group = targetGroups.get(key) ?? [];
          group.push(delivery);
          targetGroups.set(key, group);
        }

        // 할인율별 그룹핑
        const discountGroups = new Map<
          string,
          {
            fee: number;
            priceAdjustment: IPriceAdjustment | null;
            settleDiscountType: IOrderSettleDiscountType | null;
            deliveryIds: number[];
            count: number;
          }
        >();

        for (const [phoneKey, deliveries] of targetGroups) {
          const totalAmount = phoneToTotalAmount.get(phoneKey) ?? productPrice * deliveries.length;

          const resolved = resolveSettleFee(
            deliveries[0],
            {
              fee: orderProduct.fee,
              priceAdjustment: orderProduct.priceAdjustment,
              settleDiscountType: orderProduct.settleDiscountType ?? null,
            },
            isOrderCompleted,
            () =>
              findMatchingDiscount(
                {
                  price: productPrice,
                  category: product.category,
                  classificationId: product.classificationId,
                  brand: product.brand,
                },
                userDiscounts,
                totalAmount,
              ),
          );
          let { fee } = resolved;
          const { priceAdjustment, settleDiscountType } = resolved;
          if (fee < 0 || fee > 100) fee = 0;

          const feeKey = `${fee}-${priceAdjustment}`;
          const existing = discountGroups.get(feeKey);
          if (existing) {
            existing.deliveryIds.push(...deliveries.map((d) => d.id));
            existing.count += deliveries.length;
          } else {
            discountGroups.set(feeKey, {
              fee,
              priceAdjustment,
              settleDiscountType,
              deliveryIds: deliveries.map((d) => d.id),
              count: deliveries.length,
            });
          }
        }

        // 가상 행 생성
        let isFirstRow = true;
        for (const [, group] of discountGroups) {
          const groupTotalPrice = productPrice * group.count;
          const discountPrice = group.priceAdjustment
            ? OrderFeeCalculator({ fee: group.fee, priceAdjustment: group.priceAdjustment, price: productPrice })
            : productPrice;
          const discountTotalPrice = group.priceAdjustment
            ? OrderFeeCalculator({ fee: group.fee, priceAdjustment: group.priceAdjustment, price: groupTotalPrice })
            : groupTotalPrice;

          const firstDelivery = deliveryMap.get(group.deliveryIds[0]);
          resultList.push({
            id: orderProduct.id,
            brandName: lineView3a.brandName ?? null,
            name: lineView3a.name,
            price: productPrice,
            amount: group.count,
            totalPrice: groupTotalPrice,
            settleDiscountType: group.settleDiscountType,
            priceAdjustment: group.priceAdjustment,
            fee: group.fee,
            discountPrice,
            discountTotalPrice,
            discountAmount: 0,
            finalPrice: 0,
            refund: firstDelivery?.refundRatio ?? null,
            deliveryIds: group.deliveryIds,
            isSubRow: !isFirstRow,
          });
          isFirstRow = false;
          virtualTotalCount++;
        }
      }

      // Phase 3b: 크로스 상품 수신번호 — 합산 행 (상품명 결합 표시)
      const mergedGroups = new Map<
        string,
        {
          name: string;
          brandName: string | null;
          combinedPrice: number;
          discountCombinedPrice: number;
          fee: number;
          priceAdjustment: IPriceAdjustment | null;
          settleDiscountType: IOrderSettleDiscountType | null;
          deliveryIds: number[];
          phoneCount: number;
          deliveryCount: number;
          refund: number | null;
          orderProductId: number;
        }
      >();

      for (const phoneKey of multiProductPhones) {
        const totalAmount = phoneToTotalAmount.get(phoneKey) ?? 0;

        // 이 번호로 가는 모든 delivery 수집
        const phoneItems: Array<{
          orderProduct: (typeof orderProductList)[0];
          deliveryId: number;
          delivery: (typeof orderProductList)[0]['orderDeliveries'][0];
        }> = [];
        for (const orderProduct of orderProductList) {
          for (const delivery of orderProduct.orderDeliveries ?? []) {
            if (deliveryPhoneKeyCache.get(delivery.id) === phoneKey) {
              phoneItems.push({ orderProduct, deliveryId: delivery.id, delivery });
            }
          }
        }
        if (phoneItems.length === 0) continue;

        const productBreakdown = new Map<number, { name: string; count: number }>();
        for (const { orderProduct } of phoneItems) {
          const existing = productBreakdown.get(orderProduct.id);
          if (existing) existing.count++;
          else productBreakdown.set(orderProduct.id, { name: readLineProductView(orderProduct).name, count: 1 });
        }
        const sortedProducts = [...productBreakdown.entries()].sort(([a], [b]) => a - b);
        const sig = sortedProducts.map(([id, { count }]) => `${id}:${count}`).join('|');

        const itemSettles = phoneItems.map(({ orderProduct, delivery }) => {
          const product = orderProduct.product;
          const linePrice = readLineProductView(orderProduct).price;
          const resolved = resolveSettleFee(
            delivery,
            {
              fee: orderProduct.fee,
              priceAdjustment: orderProduct.priceAdjustment,
              settleDiscountType: orderProduct.settleDiscountType ?? null,
            },
            isOrderCompleted,
            () =>
              findMatchingDiscount(
                {
                  price: linePrice,
                  category: product.category,
                  classificationId: product.classificationId,
                  brand: product.brand,
                },
                userDiscounts,
                totalAmount,
              ),
          );
          let { fee } = resolved;
          if (fee < 0 || fee > 100) fee = 0;
          const priceAdjustment = resolved.priceAdjustment;
          const discountPrice = priceAdjustment
            ? OrderFeeCalculator({ fee, priceAdjustment, price: linePrice })
            : linePrice;
          return {
            orderProductId: orderProduct.id,
            fee,
            priceAdjustment,
            settleDiscountType: resolved.settleDiscountType,
            discountPrice,
          };
        });

        const settleSig = itemSettles
          .map(
            (item) =>
              `${item.orderProductId}:${item.fee}:${item.priceAdjustment ?? ''}:${item.settleDiscountType ?? ''}`,
          )
          .sort()
          .join('|');
        const groupKey = `${sig}-${settleSig}`;

        const firstSettle = itemSettles[0];
        const hasSameSettle = itemSettles.every(
          (item) =>
            item.fee === firstSettle.fee &&
            item.priceAdjustment === firstSettle.priceAdjustment &&
            item.settleDiscountType === firstSettle.settleDiscountType,
        );
        const fee = hasSameSettle ? firstSettle.fee : 0;
        const priceAdjustment = hasSameSettle ? firstSettle.priceAdjustment : null;
        const settleDiscountType = hasSameSettle ? firstSettle.settleDiscountType : null;
        const discountCombinedPrice = itemSettles.reduce((sum, item) => sum + item.discountPrice, 0);

        const existingGroup = mergedGroups.get(groupKey);
        if (existingGroup) {
          existingGroup.deliveryIds.push(...phoneItems.map((i) => i.deliveryId));
          existingGroup.phoneCount++;
          existingGroup.deliveryCount += phoneItems.length;
        } else {
          // 상품명 결합: 공통 접두어 추출 후 접미어만 + 로 연결 (각 권종별 수량 표기)
          const names = sortedProducts.map(([, v]) => v.name);
          let prefix = names[0];
          for (const n of names.slice(1)) {
            while (!n.startsWith(prefix) && prefix.length > 0) prefix = prefix.slice(0, -1);
          }
          const lastSpace = prefix.lastIndexOf(' ');
          if (lastSpace > 0) prefix = prefix.slice(0, lastSpace + 1);
          else prefix = '';
          const mergedName =
            prefix +
            sortedProducts
              .map(([, v]) => {
                const suffix = v.name.slice(prefix.length);
                return `${suffix}×${v.count}`;
              })
              .join(' + ');

          mergedGroups.set(groupKey, {
            name: mergedName,
            brandName: readLineProductView(phoneItems[0].orderProduct).brandName,
            combinedPrice: totalAmount,
            discountCombinedPrice,
            fee,
            priceAdjustment,
            settleDiscountType,
            deliveryIds: phoneItems.map((i) => i.deliveryId),
            phoneCount: 1,
            deliveryCount: phoneItems.length,
            refund: phoneItems[0].delivery?.refundRatio ?? null,
            orderProductId: phoneItems[0].orderProduct.id,
          });
        }
      }

      // 합산 행 결과 추가
      for (const [, group] of mergedGroups) {
        const groupTotalPrice = group.combinedPrice * group.phoneCount;
        const discountPrice = group.discountCombinedPrice;
        const discountTotalPrice = group.discountCombinedPrice * group.phoneCount;

        resultList.push({
          id: group.orderProductId,
          brandName: group.brandName,
          name: group.name,
          price: group.combinedPrice,
          amount: group.deliveryCount,
          totalPrice: groupTotalPrice,
          settleDiscountType: group.settleDiscountType,
          priceAdjustment: group.priceAdjustment,
          fee: group.fee,
          discountPrice,
          discountTotalPrice,
          discountAmount: 0,
          finalPrice: 0,
          refund: group.refund,
          deliveryIds: group.deliveryIds,
          isSubRow: false,
        });
        virtualTotalCount++;
      }
    } else {
      // 비SSG: 기존 로직
      resultList = orderProductList.map((orderProduct) => {
        const lineViewNonSsg = readLineProductView(orderProduct);
        const basePrice = lineViewNonSsg.price;
        let priceAdjustment = orderProduct.priceAdjustment;
        let fee = orderProduct.fee;

        let discountPrice = basePrice;
        const totalPrice = basePrice * orderProduct.amount;
        let discountTotalPrice = basePrice * orderProduct.amount;

        // 3. 할인 정보가 null 일 경우 상품에 맞는 할인 옵션 찾기
        if ((!priceAdjustment || fee === null) && !isOrderCompleted) {
          this.logger.debug(
            `[getOrderSettle] product: id=${orderProduct.product.id}, name=${orderProduct.product.name}, category='${orderProduct.product.category}', price=${basePrice}, brand=${orderProduct.product.brand?.nameKorean ?? 'null'}`,
          );
          this.logger.debug(
            `[getOrderSettle] stored values: fee=${orderProduct.fee}, priceAdjustment=${orderProduct.priceAdjustment}`,
          );

          const matchingDiscount = findMatchingDiscount(
            {
              price: basePrice,
              category: orderProduct.product.category,
              classificationId: orderProduct.product.classificationId,
              brand: orderProduct.product.brand,
            },
            userDiscounts,
          );

          this.logger.debug(
            `[getOrderSettle] matchingDiscount: ${matchingDiscount ? `id=${matchingDiscount.id}, category=${matchingDiscount.category}, method=${matchingDiscount.method}, group='${matchingDiscount.group}', range=${matchingDiscount.range}, compareCondition=${matchingDiscount.compareCondition}, priceAdjustment=${matchingDiscount.priceAdjustment}, pricePercent=${matchingDiscount.pricePercent}` : 'null (no match found)'}`,
          );

          // 4. 할인 정보가 존재하면 null 값만 채우기
          if (matchingDiscount) {
            priceAdjustment = priceAdjustment ?? matchingDiscount.priceAdjustment;
            fee = fee ?? matchingDiscount.pricePercent;
          }
          fee = fee ?? 0;
        } else if (fee === null) {
          fee = 0;
        }

        // fee 유효성 검사 (0은 허용)
        if (fee === null || fee < 0 || fee > 100) {
          fee = 0;
        }

        discountPrice = OrderFeeCalculator({
          fee: fee!,
          priceAdjustment: priceAdjustment!,
          price: basePrice,
        });
        discountTotalPrice = OrderFeeCalculator({
          fee: fee!,
          priceAdjustment: priceAdjustment!,
          price: totalPrice,
        });

        // 해당 상품의 첫 번째 orderDelivery에서 refundRatio 가져오기
        const firstDelivery = orderProduct.orderDeliveries?.[0];
        const refund = firstDelivery?.refundRatio ?? null;

        return {
          id: orderProduct.id,
          brandName: lineViewNonSsg.brandName ?? null,
          name: lineViewNonSsg.name,
          price: basePrice,
          amount: orderProduct.amount,
          totalPrice: basePrice * orderProduct.amount,
          settleDiscountType: orderProduct.settleDiscountType ?? null,
          priceAdjustment,
          fee,
          discountPrice,
          discountTotalPrice,
          discountAmount: 0,
          finalPrice: 0,
          refund,
        };
      });
      virtualTotalCount = resultList.length;
    }

    resultList = resultList.map((row) => ({
      ...row,
      finalPrice: row.discountTotalPrice ?? 0,
      discountAmount: (row.totalPrice ?? 0) - (row.discountTotalPrice ?? 0),
    }));

    const totalDiscountAmount = resultList.reduce((sum, row) => sum + (row.finalPrice ?? 0), 0);
    const pagedList = resultList.slice(skip, skip + take);
    const totalPage = Math.ceil(virtualTotalCount / take);

    // 입력완료 표식 = order.settleMethod 존재 (settleAmount>0 의존 제거 — 0원 정산도 입력값 유지)
    const hasSettleInput = order.settleMethod != null;
    // 정책 폴백은 미입력일 때만 필요. 읽기 경로는 fail-closed 불필요 → lazy 해석으로 WALLET 불필요 throw/조회 회피.
    let settlePolicy: 'CARD' | 'CASH' | null;
    let effectiveCardSurcharge: boolean;
    if (hasSettleInput) {
      settlePolicy = null;
      effectiveCardSurcharge = order.cardSurchargeApplied;
    } else {
      const resolved = await this.resolveSettlePolicy(order, billingUserForSettle?.company);
      settlePolicy = resolved.policy;
      effectiveCardSurcharge = resolved.policy === 'CARD' && (resolved.resolvedWallet?.cardSurchargeApplied ?? true);
    }

    // 카드할증 산정 (백엔드 산식 단일화: 프론트 자체계산 제거)
    const cardSurchargeBase = totalDiscountAmount;
    const payableSettlementAmount = applyCardSurcharge(cardSurchargeBase, effectiveCardSurcharge);
    const cardSurchargeAmount = payableSettlementAmount - cardSurchargeBase;

    // settleMethod: 저장값 우선, NULL(미입력/레거시)이면 정책 폴백
    const effectiveSettleMethod = order.settleMethod ?? settlePolicy;

    return {
      list: pagedList,
      currentPage: page,
      totalCount,
      totalPage,
      virtualTotalCount,
      totalDiscountAmount,
      settleMethod: effectiveSettleMethod,
      cardSurchargeApplied: effectiveCardSurcharge,
      cardSurchargeBase,
      cardSurchargeAmount,
      payableSettlementAmount,
    };
  }

  /**
   * createOrderSettle/updateOrderSettle 공통: SSG 가상 행 처리 + settleFee 계산
   */
  private async processSettleList(
    list: OrderCreateSettleReqDto['list'],
    existingOrderProductMap: Map<number, any>,
  ): Promise<{
    orderProductList: ReturnType<typeof this.orderProductMappingRepository.create>[];
  }> {
    const hasDeliveryScopedRows = list.some((settle) => settle.deliveryIds && settle.deliveryIds.length > 0);
    const orderProductList: ReturnType<typeof this.orderProductMappingRepository.create>[] = [];
    const processedMappingIds = new Set<number>();
    const updatedDeliveryIds = new Set<number>(); // 이번 call 에서 실제 업데이트된 delivery ID 추적 (D3-42 후처리용)
    const deliveryUpdatePromises: Promise<unknown>[] = [];
    const refundPromises: Promise<unknown>[] = [];

    // 합산 행(크로스 상품 수신번호) 대응: 주문 전체 delivery 를 한 map 으로 모은다.
    // 합산 행은 deliveryIds 가 여러 상품에 걸쳐 있어 상품 하나의 deliveries 로는 검증/동기화할 수 없다.
    const allDeliveryById = new Map<number, OrderDeliveryEntity>(
      [...existingOrderProductMap.values()].flatMap((orderProduct) =>
        ((orderProduct.orderDeliveries ?? []) as OrderDeliveryEntity[]).map((d) => [d.id, d]),
      ),
    );

    for (const settle of list) {
      const oneOrderProduct = existingOrderProductMap.get(settle.id);
      if (!oneOrderProduct) {
        throw new InternalServerErrorException('not exist order product');
      }

      // optional 필드 "없음"=null 계약을 한 곳에서 정규화해 delivery 저장/비교/mapping 저장에 동일 적용.
      // (undefined 누락분이 delivery=null 과 어긋나 mapping 대표값 sync 가 누락되던 회귀 방지)
      const normSettleDiscountType = settle.settleDiscountType ?? null;
      const normPriceAdjustment = settle.priceAdjustment ?? null;

      if (settle.deliveryIds && settle.deliveryIds.length > 0) {
        for (const deliveryId of settle.deliveryIds) {
          if (!allDeliveryById.has(deliveryId)) {
            throw new BadRequestException('주문에 속하지 않는 발송 내역이 포함되어 있습니다.');
          }
          const delivery = allDeliveryById.get(deliveryId)!;
          delivery.settleFee = settle.fee;
          delivery.settlePriceAdjustment = normPriceAdjustment;
          delivery.settleDiscountType = normSettleDiscountType;
          updatedDeliveryIds.add(deliveryId);
        }

        deliveryUpdatePromises.push(
          this.orderDeliveryRepository.update(
            { id: In(settle.deliveryIds) },
            {
              settleFee: settle.fee,
              settlePriceAdjustment: normPriceAdjustment,
              settleDiscountType: normSettleDiscountType,
            },
          ),
        );

        if (settle.refund !== undefined) {
          refundPromises.push(
            this.orderDeliveryRepository.update({ id: In(settle.deliveryIds) }, { refundRatio: settle.refund }),
          );
          for (const deliveryId of settle.deliveryIds) {
            allDeliveryById.get(deliveryId)!.refundRatio = settle.refund;
          }
        }

        const mappingDeliveries = oneOrderProduct.orderDeliveries ?? [];
        const shouldSyncMapping =
          mappingDeliveries.length > 0 &&
          mappingDeliveries.every(
            (delivery: OrderDeliveryEntity) =>
              delivery.settleFee === settle.fee &&
              delivery.settlePriceAdjustment === normPriceAdjustment &&
              delivery.settleDiscountType === normSettleDiscountType,
          );

        if (shouldSyncMapping && !processedMappingIds.has(settle.id)) {
          processedMappingIds.add(settle.id);
          oneOrderProduct.settleDiscountType = normSettleDiscountType;
          oneOrderProduct.priceAdjustment = normPriceAdjustment;
          oneOrderProduct.fee = settle.fee;
          orderProductList.push(
            this.orderProductMappingRepository.create({
              id: settle.id,
              settleDiscountType: normSettleDiscountType,
              priceAdjustment: normPriceAdjustment,
              fee: settle.fee,
            }),
          );
        }
        continue;
      }

      if (!hasDeliveryScopedRows && !processedMappingIds.has(settle.id)) {
        processedMappingIds.add(settle.id);
        oneOrderProduct.settleDiscountType = normSettleDiscountType;
        oneOrderProduct.priceAdjustment = normPriceAdjustment;
        oneOrderProduct.fee = settle.fee;
        orderProductList.push(
          this.orderProductMappingRepository.create({
            id: settle.id,
            settleDiscountType: normSettleDiscountType,
            priceAdjustment: normPriceAdjustment,
            fee: settle.fee,
          }),
        );
      }

      if (settle.refund !== undefined) {
        refundPromises.push(
          this.orderDeliveryRepository.update({ orderProductMappingId: settle.id }, { refundRatio: settle.refund }),
        );
        for (const delivery of oneOrderProduct.orderDeliveries ?? []) {
          delivery.refundRatio = settle.refund;
        }
      }
    }

    await Promise.all(deliveryUpdatePromises);
    await Promise.all(refundPromises);

    // 합본행(크로스 수신번호) 후처리: deliveryIds 에만 등장하고 settle.id 로는 한 번도 처리되지 않은
    // mapping 의 deliveries 가 이번 call 에서 모두 동일한 정산값으로 갱신됐으면 대표값을 동기화한다.
    // - settle.id 가 없는 mapping 은 메인 루프에서 shouldSyncMapping 평가 자체가 생략됨 (D3-42)
    // - updatedDeliveryIds 조건: 이번 call 에서 건드리지 않은 mapping 은 기존 DB 값으로 오염되지 않도록 제외
    if (hasDeliveryScopedRows) {
      for (const [mappingId, orderProduct] of existingOrderProductMap.entries()) {
        if (processedMappingIds.has(mappingId)) continue;
        const deliveries: OrderDeliveryEntity[] = orderProduct.orderDeliveries ?? [];
        if (deliveries.length === 0) continue;
        // 이번 call 에서 실제로 업데이트된 delivery 가 없으면 skip (관련 없는 mapping 방지)
        if (!deliveries.some((d: OrderDeliveryEntity) => updatedDeliveryIds.has(d.id))) continue;
        const first = deliveries[0];
        const allSame = deliveries.every(
          (d: OrderDeliveryEntity) =>
            d.settleFee === first.settleFee &&
            d.settlePriceAdjustment === first.settlePriceAdjustment &&
            d.settleDiscountType === first.settleDiscountType,
        );
        if (allSame) {
          processedMappingIds.add(mappingId);
          orderProduct.fee = first.settleFee;
          orderProduct.priceAdjustment = first.settlePriceAdjustment;
          orderProduct.settleDiscountType = first.settleDiscountType;
          orderProductList.push(
            this.orderProductMappingRepository.create({
              id: mappingId,
              settleDiscountType: first.settleDiscountType,
              priceAdjustment: first.settlePriceAdjustment,
              fee: first.settleFee,
            }),
          );
        }
      }
    }

    return { orderProductList };
  }

  private async getOrderProductsForSettlementAmount(orderId: number) {
    return this.orderProductMappingRepository
      .createQueryBuilder('orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .leftJoinAndSelect('orderProductMapping.orderDeliveries', 'orderDeliveries')
      .where('orderProductMapping.orderId = :orderId', { orderId })
      .getMany();
  }

  /**
   * 부분취소 정산금액 재계산 전용 로더 (197-16).
   *
   * 위 getOrderProductsForSettlementAmount(정산수정과 공유)는 product 를 **innerJoin** 한다.
   * ProductEntity 는 BaseEntity 의 @DeleteDateColumn 을 갖기 때문에, 주문 이후 상품이 소프트삭제되면
   * TypeORM 이 조인에 deleted_at IS NULL 을 걸어 **그 매핑 행이 결과에서 통째로 사라진다.**
   * 그 상태로 재계산하면 삭제 상품 몫이 0으로 세어져 settleAmount 가 실제보다 낮게(전부 삭제면 0)
   * 저장되고, 이후 전체취소가 신흐름에서 그 값을 그대로 환불액으로 읽어
   * (refundAmount = order.settleAmount → refundAmount > 0 단락평가로 wallet 경로 자체가 스킵)
   * **취소는 되고 환불은 0원** 이 된다. 매핑 일부만 삭제되면 과소환불이라 더 늦게 발견된다.
   *
   * 그래서 여기서는 product 를 **leftJoin** 해 매핑 행을 남긴다. 단가는 정산 계산이 이미
   * readLineProductView(snapshotProductPrice ?? product?.price ?? 0)로 읽으므로, 상품이 없어도
   * **주문 시점 스냅샷 단가**로 정확히 재계산된다 — 전체취소가 정가 폴백에 쓰는 정책과 동일하다.
   *
   * ※ 상품이 살아 있으면 leftJoin 과 innerJoin 은 같은 행을 돌려주므로, 정산수정(createOrderSettle)의
   *   difference 블록과 기준이 어긋나지 않는다(difference = 0 유지). 오직 소프트삭제된 경우에만
   *   갈라지며, 그때 갈라지는 쪽이 옳다. 공유 헬퍼를 고치지 않고 분리한 이유는 정산수정 경로까지
   *   기준이 바뀌는 파급을 이 티켓에서 지지 않기 위해서다.
   */
  private async getOrderProductsForCancelSettlement(orderId: number) {
    return this.orderProductMappingRepository
      .createQueryBuilder('orderProductMapping')
      .leftJoinAndSelect('orderProductMapping.product', 'product')
      .leftJoinAndSelect('orderProductMapping.orderDeliveries', 'orderDeliveries')
      .where('orderProductMapping.orderId = :orderId', { orderId })
      .getMany();
  }

  /**
   * 정산 변경이력용: 매핑들의 현재 정산 필드(fee/priceAdjustment/settleDiscountType)와 상품명을 스냅샷으로 캡처한다.
   * 정산 처리 로직이 엔티티를 in-place mutate 하므로, 반드시 mutate 이전에 호출해야 before 값이 보존된다.
   */
  private captureSettleSnapshot(
    mappings: Array<{
      id: number;
      fee: number | null;
      priceAdjustment: IPriceAdjustment | null;
      settleDiscountType: IOrderSettleDiscountType | null;
      product?: { name?: string | null } | null;
      orderDeliveries?: Array<{
        id: number;
        settleFee: number | null;
        settlePriceAdjustment: IPriceAdjustment | null;
        settleDiscountType: IOrderSettleDiscountType | null;
      }> | null;
    }>,
  ): SettleSnapshot {
    const beforeById = new Map<number, SettleFieldSnapshot>();
    const productNameById = new Map<number, string>();
    const deliveryBeforeById = new Map<number, { mappingId: number } & SettleDeliverySnapshot>();
    for (const mapping of mappings) {
      beforeById.set(mapping.id, {
        fee: mapping.fee,
        priceAdjustment: mapping.priceAdjustment,
        settleDiscountType: mapping.settleDiscountType,
      });
      if (mapping.product?.name) {
        productNameById.set(mapping.id, mapping.product.name);
      }
      for (const delivery of mapping.orderDeliveries ?? []) {
        deliveryBeforeById.set(delivery.id, {
          mappingId: mapping.id,
          settleFee: delivery.settleFee,
          settlePriceAdjustment: delivery.settlePriceAdjustment,
          settleDiscountType: delivery.settleDiscountType,
        });
      }
    }
    return { beforeById, productNameById, deliveryBeforeById };
  }

  /**
   * 정산 할인/할증 변경이력을 activity_log 에 기록한다 (성공만 영구보존 — purge 제외 actionType).
   * - 운영자 신원(user)이 없으면(단위테스트 등 비-API 경로) 기록을 생략한다. 실제 API 경로는 항상 user 가 존재한다.
   * - 실제 변경(매핑 change 또는 주문 결제수단/카드할증 변경)이 없으면 기록하지 않는다.
   * - @Transactional 내부에서 호출되어 정산 저장과 동일 트랜잭션으로 커밋/롤백된다.
   */
  private async logSettleDiscountChange(params: {
    user?: ILoginUserInfo;
    orderId: number;
    requestUrl: string;
    method: string;
    source: SettleDiscountChangeSource;
    changes: SettleDiscountChange[];
    deliveryChanges?: SettleDeliveryChange[];
    orderBefore?: SettleOrderSnapshot;
    orderAfter?: SettleOrderSnapshot & { settleAmount: number };
  }): Promise<void> {
    const { user } = params;
    if (!user) {
      return;
    }
    const orderChanged = Boolean(
      params.orderBefore && params.orderAfter && isSettleOrderChanged(params.orderBefore, params.orderAfter),
    );
    const deliveryChanges = params.deliveryChanges ?? [];
    if (params.changes.length === 0 && deliveryChanges.length === 0 && !orderChanged) {
      return;
    }
    await this.activityLogService.createLog({
      userId: user.id,
      userEmail: user.email,
      method: params.method,
      requestUrl: params.requestUrl,
      actionType: SETTLE_DISCOUNT_SOURCE_ACTION_TYPE[params.source],
      ipAddress: '',
      statusCode: 200,
      result: ActivityLogResult.SUCCESS,
      responseTime: 0,
      requestParams: {
        orderId: params.orderId,
        source: params.source,
        changes: params.changes,
        ...(deliveryChanges.length > 0 ? { deliveryChanges } : {}),
        ...(orderChanged ? { order: { before: params.orderBefore, after: params.orderAfter } } : {}),
      },
    });
  }

  /**
   * 수동 정산입력(create/update) 성공 시 매핑/delivery 변경을 조립해 기록한다.
   * mapping 대표값 변경은 changes, mapping 에 롤업되지 않는 delivery 부분변경은 deliveryChanges 로 남긴다.
   */
  private async logManualSettleChange(params: {
    user?: ILoginUserInfo;
    orderId: number;
    method: string;
    snapshot: SettleSnapshot;
    savedMappings: Array<{ id: number } & SettleFieldSnapshot>;
    allMappings: Array<{ id: number; orderDeliveries?: Array<{ id: number } & SettleDeliverySnapshot> | null }>;
    orderBefore: SettleOrderSnapshot;
    orderAfter: SettleOrderSnapshot & { settleAmount: number };
  }): Promise<void> {
    const changes = buildSettleDiscountChanges(
      params.snapshot.beforeById,
      params.savedMappings,
      params.snapshot.productNameById,
    );
    const deliveryChanges = buildSettleDeliveryChanges(
      params.snapshot.deliveryBeforeById,
      params.allMappings,
      new Set(changes.map((change) => change.mappingId)),
      params.snapshot.productNameById,
    );
    await this.logSettleDiscountChange({
      user: params.user,
      orderId: params.orderId,
      requestUrl: '/order/settle',
      method: params.method,
      source: SettleDiscountChangeSource.MANUAL,
      changes,
      deliveryChanges,
      orderBefore: params.orderBefore,
      orderAfter: params.orderAfter,
    });
  }

  @Transactional()
  async createOrderSettle(getBody: OrderCreateSettleReqDto, user?: ILoginUserInfo) {
    const { list } = getBody;

    if (list.length === 0) {
      return;
    }

    const orderProductIds = list.map((item) => item.id);

    const existingOrderProducts = await this.orderProductMappingRepository
      .createQueryBuilder('orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .leftJoinAndSelect('orderProductMapping.orderDeliveries', 'orderDeliveries')
      .where('orderProductMapping.id IN (:...orderProductIds)', { orderProductIds })
      .getMany();

    const existingOrderProductMap = new Map(existingOrderProducts.map((order) => [order.id, order]));

    const missOrderProductIds = orderProductIds.filter((id) => !existingOrderProductMap.has(id));
    if (missOrderProductIds.length > 0) {
      throw new BadRequestException('존재하지 않는 주문 내역이 있습니다');
    }

    const orderId = existingOrderProducts[0].orderId;
    const hasDifferentOrder = existingOrderProducts.some((orderProduct) => orderProduct.orderId !== orderId);
    if (hasDifferentOrder) {
      throw new BadRequestException('하나의 주문에 대해서만 정산 정보를 입력할 수 있습니다');
    }
    const allOrderProducts = await this.getOrderProductsForSettlementAmount(orderId);
    const allOrderProductMap = new Map(allOrderProducts.map((order) => [order.id, order]));
    const oneUserId = existingOrderProducts[0].order.clientUserId ?? existingOrderProducts[0].order.userId;
    const sendAmount = existingOrderProducts[0].order.sendAmount;
    const isSettleBalance = existingOrderProducts[0].order.isSettleBalance;
    // 정산 변경이력(성공만 영구기록): 처리 전 상태 스냅샷.
    // processSettleList 가 mapping 엔티티를 mutate 하므로 반드시 이 시점에 캡처해야 한다.
    const settleSnapshot = this.captureSettleSnapshot(allOrderProducts);
    const settleOrderBefore: SettleOrderSnapshot = {
      settleMethod: existingOrderProducts[0].order.settleMethod,
      cardSurchargeApplied: existingOrderProducts[0].order.cardSurchargeApplied,
    };

    assertSettleListDeliveryCoverage(list, allOrderProducts, { requireFullCoverage: true });
    const { orderProductList } = await this.processSettleList(list, allOrderProductMap);

    if (orderProductList.length > 0) {
      await this.orderProductMappingRepository.save(orderProductList);
    }

    const order = existingOrderProducts[0].order;
    // create: 기존값 폴백 없음 (order.settleMethod / order.cardSurchargeApplied 무시)
    const { cardSurchargeApplied, settleMethod } = await this.resolveSettleInputs(order, getBody, {
      useExistingAsMiddleFallback: false,
    });
    const newSettleAmount = calculateOrderSettlementAmount(
      { cardSurchargeApplied, orderProductMappings: allOrderProducts },
      cardSurchargeApplied,
    );

    await this.orderRepository.update(
      { id: orderId },
      { settleAmount: newSettleAmount, cardSurchargeApplied, settleMethod },
    );

    await this.logManualSettleChange({
      user,
      orderId,
      method: 'POST',
      snapshot: settleSnapshot,
      savedMappings: orderProductList,
      allMappings: allOrderProducts,
      orderBefore: settleOrderBefore,
      orderAfter: { settleMethod, cardSurchargeApplied, settleAmount: newSettleAmount },
    });

    if (order.isNewBillingFlow) {
      // === 새 흐름 ===
      if (order.status === IOrderStatus.DELIVERY_CONFIRMED || order.status === IOrderStatus.DELIVERY_COMPLETE) {
        // 발송확정 후 정산 입력: difference 기반 조정 (updateOrderSettle 패턴)
        const difference = order.settleAmount - newSettleAmount;
        if (difference !== 0) {
          const oneUser = await this.userRepository.findOneOrFail({
            where: { id: oneUserId },
            relations: ['company'],
          });
          const isCompanyBalanceMode = oneUser.company?.balanceManagementType === 'COMPANY';

          if (isSettleBalance) {
            if (isCompanyBalanceMode && oneUser.company) {
              oneUser.company.balance += difference;
              await this.userCompanyRepository.save(oneUser.company);
            } else {
              oneUser.balance += difference;
              await this.userRepository.save(oneUser);
            }
          } else {
            oneUser.allSettleAmount -= difference;
            await this.userRepository.save(oneUser);
          }
        }
      }
      // DELIVERY_REQUEST, REVIEW_COMPLETE: 정산 정보만 저장 (balance 건드리지 않음)
    } else {
      // === 기존 흐름 ===
      const oneUser = await this.userRepository.findOneOrFail({
        where: { id: oneUserId },
        relations: ['company'],
      });
      const isCompanyBalanceMode = oneUser.company?.balanceManagementType === 'COMPANY';

      if (isSettleBalance) {
        if (isCompanyBalanceMode && oneUser.company) {
          oneUser.company.balance = oneUser.company.balance + sendAmount - newSettleAmount;
          await this.userCompanyRepository.save(oneUser.company);
        } else {
          oneUser.balance = oneUser.balance + sendAmount - newSettleAmount;
          await this.userRepository.save(oneUser);
        }
      } else {
        oneUser.allSettleAmount = oneUser.allSettleAmount - sendAmount + newSettleAmount;
        await this.userRepository.save(oneUser);
      }
    }
  }

  @Transactional()
  async updateOrderSettle(getBody: OrderUpdateSettleReqDto, user?: ILoginUserInfo) {
    const { list } = getBody;

    if (list.length === 0) {
      return;
    }

    const orderProductIds = list.map((item) => item.id);

    const existingOrderProducts = await this.orderProductMappingRepository
      .createQueryBuilder('orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .leftJoinAndSelect('orderProductMapping.orderDeliveries', 'orderDeliveries')
      .where('orderProductMapping.id IN (:...orderProductIds)', { orderProductIds })
      .getMany();

    const existingOrderProductMap = new Map(existingOrderProducts.map((order) => [order.id, order]));

    const missOrderProductIds = orderProductIds.filter((id) => !existingOrderProductMap.has(id));
    if (missOrderProductIds.length > 0) {
      throw new BadRequestException('존재하지 않는 주문 내역이 있습니다');
    }

    const orderId = existingOrderProducts[0].orderId;
    const hasDifferentOrder = existingOrderProducts.some((orderProduct) => orderProduct.orderId !== orderId);
    if (hasDifferentOrder) {
      throw new BadRequestException('하나의 주문에 대해서만 정산 정보를 수정할 수 있습니다');
    }
    const allOrderProducts = await this.getOrderProductsForSettlementAmount(orderId);
    const allOrderProductMap = new Map(allOrderProducts.map((order) => [order.id, order]));
    const oneUserId = existingOrderProducts[0].order.clientUserId ?? existingOrderProducts[0].order.userId;

    const beforeSettleAmount = existingOrderProducts[0].order.settleAmount;
    const isSettleBalance = existingOrderProducts[0].order.isSettleBalance;
    // 정산 변경이력(성공만 영구기록): 처리 전 상태 스냅샷.
    const settleSnapshot = this.captureSettleSnapshot(allOrderProducts);
    const settleOrderBefore: SettleOrderSnapshot = {
      settleMethod: existingOrderProducts[0].order.settleMethod,
      cardSurchargeApplied: existingOrderProducts[0].order.cardSurchargeApplied,
    };

    assertSettleListDeliveryCoverage(list, allOrderProducts, { requireFullCoverage: false });
    const { orderProductList } = await this.processSettleList(list, allOrderProductMap);

    if (orderProductList.length > 0) {
      await this.orderProductMappingRepository.save(orderProductList);
    }

    const order = existingOrderProducts[0].order;
    // update: 기존값(order.cardSurchargeApplied / order.settleMethod)을 body와 정책 사이 중간 폴백으로 사용
    const { cardSurchargeApplied, settleMethod } = await this.resolveSettleInputs(order, getBody, {
      useExistingAsMiddleFallback: true,
    });
    const newSettleAmount = calculateOrderSettlementAmount(
      { cardSurchargeApplied, orderProductMappings: allOrderProducts },
      cardSurchargeApplied,
    );

    await this.orderRepository.update(
      { id: orderId },
      { settleAmount: newSettleAmount, cardSurchargeApplied, settleMethod },
    );

    await this.logManualSettleChange({
      user,
      orderId,
      method: 'PUT',
      snapshot: settleSnapshot,
      savedMappings: orderProductList,
      allMappings: allOrderProducts,
      orderBefore: settleOrderBefore,
      orderAfter: { settleMethod, cardSurchargeApplied, settleAmount: newSettleAmount },
    });

    // 발송확정 이후(DELIVERY_CONFIRMED, DELIVERY_COMPLETE)에 정산정보를 수정한 경우
    // 이전 정산금액과 새 정산금액의 차이를 balance/allSettleAmount에 반영
    const orderStatus = existingOrderProducts[0].order.status;
    if (orderStatus === IOrderStatus.DELIVERY_CONFIRMED || orderStatus === IOrderStatus.DELIVERY_COMPLETE) {
      const difference = beforeSettleAmount - newSettleAmount;

      if (difference !== 0) {
        const oneUser = await this.userRepository.findOneOrFail({
          where: { id: oneUserId },
          relations: ['company'],
        });
        const isCompanyBalanceMode = oneUser.company?.balanceManagementType === 'COMPANY';

        if (isSettleBalance) {
          // 선충전에서 차감된 주문 → balance 조정
          if (isCompanyBalanceMode && oneUser.company) {
            oneUser.company.balance += difference;
            await this.userCompanyRepository.save(oneUser.company);
          } else {
            oneUser.balance += difference;
            await this.userRepository.save(oneUser);
          }
          this.logger.debug(
            `정산정보 수정 (발송확정 후): orderId=${orderId}, 이전=${beforeSettleAmount}, 새=${newSettleAmount}, 차이=${difference}, balance 조정 (companyMode=${isCompanyBalanceMode})`,
          );
        } else {
          // 한도에서 차감된 주문 → allSettleAmount 조정
          oneUser.allSettleAmount -= difference;
          await this.userRepository.save(oneUser);
          this.logger.debug(
            `정산정보 수정 (발송확정 후): orderId=${orderId}, 이전=${beforeSettleAmount}, 새=${newSettleAmount}, 차이=${difference}, allSettleAmount 조정`,
          );
        }
      }
    }
    // 발송요청 상태(DELIVERY_REQUEST)인 경우 balance 조정은 deliveryConfirmed에서 수행됨
  }

  /**
   * 주어진 유저의 허용 발신수단으로 주문 상품의 sendMethod를 검증한다.
   * 대행주문인 경우 clientUser, 직접주문인 경우 주문등록자의 설정을 사용한다.
   */
  private async validateSendMethods(
    clientUserId: number | null,
    currentUserId: number,
    orderProductList: { sendMethod?: string | null }[],
  ): Promise<void> {
    const targetUserId = clientUserId ?? currentUserId;
    const userEntity = await this.userRepository.findOne({ where: { id: targetUserId } });
    if (!userEntity) {
      throw new BadRequestException('사용자 정보를 찾을 수 없습니다.');
    }
    const allowedMethods = userEntity.allowedSendMethods
      ? userEntity.allowedSendMethods.split(',').map((m) => (m === 'SMS' ? 'MMS' : m))
      : ['ALIM_TALK', 'MMS', 'EMAIL'];

    for (const product of orderProductList) {
      if (product.sendMethod && !allowedMethods.includes(product.sendMethod)) {
        throw new BadRequestException(`허용되지 않은 발신수단입니다: ${product.sendMethod}`);
      }
    }
  }

  /**
   * 상품 행(임시저장 DTO / 저장된 주문 매핑 공통)에서 금칙어 검사 대상 필드 수집.
   * - 대상: sendTitle / sendContent / useEmailContent / sendTailText, 수신자별 대치문자 1/2/3.
   * - 빈/null 필드는 skip.
   */
  private static collectForbiddenWordTargets(
    rows: {
      sendTitle?: string | null;
      sendContent?: string | null;
      useEmailContent?: string | null;
      sendTailText?: string | null;
      deliveries: {
        replaceCharacter1?: string | null;
        replaceCharacter2?: string | null;
        replaceCharacter3?: string | null;
      }[];
    }[],
  ): { field: string; text: string }[] {
    const targets: { field: string; text: string }[] = [];
    const push = (field: string, text: string | null | undefined) => {
      if (text) targets.push({ field, text });
    };

    for (const row of rows) {
      push('sendTitle', row.sendTitle);
      push('sendContent', row.sendContent);
      push('useEmailContent', row.useEmailContent);
      push('sendTailText', row.sendTailText);

      for (const delivery of row.deliveries) {
        push('replaceCharacter1', delivery.replaceCharacter1);
        push('replaceCharacter2', delivery.replaceCharacter2);
        push('replaceCharacter3', delivery.replaceCharacter3);
      }
    }

    return targets;
  }

  /**
   * 임시저장/수정 콘텐츠 금칙어 검사. 적발 시 block_log 기록 후 BadRequestException(FORBIDDEN_WORD).
   * eventName(이벤트명)은 주문 레벨 필드라 상품 행과 별도로 검사한다.
   */
  private async assertNoForbiddenWord(
    user: ILoginUserInfo,
    orderProductList: OrderProductCreateTempDto[],
    orderId: number | null,
    eventName?: string | null,
  ): Promise<void> {
    const targets = OrderService.collectForbiddenWordTargets(
      orderProductList.map((product) => ({ ...product, deliveries: product.orderDeliveryList ?? [] })),
    );
    if (eventName) {
      targets.push({ field: 'eventName', text: eventName });
    }
    await this.assertTargetsHaveNoForbiddenWord(user, targets, orderId);
  }

  /**
   * 발송요청 직전 금칙어 최종 차단(저장된 주문 엔티티 기준).
   * 임시저장 이후 금칙어 추가, 발송관리 패치(꼬리광고/이메일 사용방법 등)로 인한 우회를 막는다.
   */
  private async assertNoForbiddenWordInOrder(user: ILoginUserInfo, order: OrderEntity): Promise<void> {
    const targets = OrderService.collectForbiddenWordTargets(
      (order.orderProductMappings ?? []).map((mapping) => ({
        ...mapping,
        deliveries: mapping.orderDeliveries ?? [],
      })),
    );
    if (order.eventName) {
      targets.push({ field: 'eventName', text: order.eventName });
    }
    await this.assertTargetsHaveNoForbiddenWord(user, targets, order.id);
  }

  /**
   * 금칙어 검사 공통 로직: 전 필드를 스캔해 적발 필드별 block_log 기록 후,
   * 적발 단어 합집합(중복 제거)으로 BadRequestException(FORBIDDEN_WORD) throw.
   * (첫 필드에서 즉시 throw하면 교차 필드 적발 시 FE 안내 팝업에 단어가 누락된다)
   * block_log insert 실패는 warn 후에도 reject 유지.
   */
  private async assertTargetsHaveNoForbiddenWord(
    user: ILoginUserInfo,
    targets: { field: string; text: string }[],
    orderId: number | null,
  ): Promise<void> {
    const allWords: string[] = [];

    for (const target of targets) {
      const matchedWords = this.forbiddenWordMatcher.scan(target.text);
      if (matchedWords.length === 0) {
        continue;
      }

      try {
        await this.writeForbiddenWordBlockLog({
          userId: user.id,
          userEmail: user.email,
          matchedWords,
          field: target.field,
          contentSnippet: target.text.slice(0, 500),
          orderId,
        });
      } catch (e) {
        this.logger.warn(`금칙어 차단 로그 기록 실패: ${(e as Error).message}`);
      }

      for (const word of matchedWords) {
        if (!allWords.includes(word)) {
          allWords.push(word);
        }
      }
    }

    if (allWords.length > 0) {
      throw new BadRequestException({
        code: 'FORBIDDEN_WORD',
        words: allWords,
        message: '금칙어가 포함되어 있습니다.',
      });
    }
  }

  /**
   * 금칙어 차단 로그를 부모 트랜잭션과 분리된 새 트랜잭션(REQUIRES_NEW)으로 기록한다.
   * createTemp/updateTemp/deliveryRequest 는 적발 시 BadRequestException 을 던져 부모
   * 트랜잭션을 롤백하는데, 같은 트랜잭션에 기록하면 차단 로그까지 롤백돼 이력이 남지 않는다.
   */
  @Transactional({ propagation: Propagation.REQUIRES_NEW })
  private async writeForbiddenWordBlockLog(entry: {
    userId: number;
    userEmail: string;
    matchedWords: string[];
    field: string;
    contentSnippet: string;
    orderId: number | null;
  }): Promise<void> {
    await this.forbiddenWordBlockLogRepository.insert(entry);
  }

  private async assertPositiveIntegerAmounts(orderProductList: OrderProductCreateTempDto[]): Promise<void> {
    const invalidItems = orderProductList
      .map((product, index) => ({ order: index + 1, productId: product.productId, amount: product.amount }))
      .filter((item) => !Number.isInteger(item.amount) || item.amount < 1);

    if (invalidItems.length === 0) {
      return;
    }

    // 오류 상품명은 안내용으로만 조회 — 조회 실패해도 순번 기준으로 폴백
    const nameMap = new Map<number, string>();
    try {
      const productIds = [...new Set(invalidItems.map((item) => item.productId).filter((id) => Number.isInteger(id)))];
      if (productIds.length > 0) {
        const products = await this.productRepository.find({
          where: { id: In(productIds) },
          select: ['id', 'name'],
        });
        for (const product of products) {
          nameMap.set(product.id, product.name);
        }
      }
    } catch {
      // 상품명 조회 실패는 무시하고 순번만 안내
    }

    const detail = invalidItems
      .map((item) => {
        const name = nameMap.get(item.productId);
        return `- 상품${item.order}${name ? ` (${name})` : ''}`;
      })
      .join('\n');

    throw new BadRequestException(
      `수량이 올바르지 않은 상품이 있습니다. 각 상품에 수신번호를 1개 이상 입력해주세요.\n\n${detail}`,
    );
  }

  @Transactional()
  async createTemp(user: ILoginUserInfo, getBody: OrderCreateTempReqDto): Promise<OrderCreateTempResDto> {
    const { type, eventName, topImagePath, midImagePath, orderProductList } = getBody;

    await this.assertPositiveIntegerAmounts(orderProductList);
    await this.assertNoForbiddenWord(user, orderProductList, null, eventName);

    // 대행주문인 경우 clientUser의 허용 발신수단으로 검증
    const clientUserId = getBody.clientUserId ?? null;
    await this.validateSendMethods(clientUserId, user.id, orderProductList);

    const ssgReservationRange = type === IOrderType.SSG ? await this.ssgEventService.getReservationRange() : null;
    validateSsgReservationWindow(type, orderProductList, ssgReservationRange);
    // SSG 주문은 즉시/예약 발송을 혼합할 수 없음 (혼합 시 400). 예약시각은 상품 행별로 달라도 됨
    validateSsgUniformSend(type, orderProductList);

    // 동일 productId를 여러 행으로 저장할 수 있으므로 상품 조회는 unique 기준으로 수행
    const uniqueProductIds = [...new Set(orderProductList.map((product) => product.productId))];

    const getProductList = await this.productRepository.find({
      where: {
        id: In(uniqueProductIds),
      },
      relations: ['brand', 'partnerCompany', 'partnerCompany.userDiscounts'],
    });

    if (uniqueProductIds.length !== getProductList.length) {
      throw new BadRequestException('존재하지 않는 상품을 추가하였습니다.');
    }
    const productPriceMap = listToMap(getProductList, (product) => product.id);

    // 전송 정산 가격 적용
    let sendAmount = 0;

    for (const orderProduct of orderProductList) {
      const getProduct = productPriceMap.get(orderProduct.productId)!;
      sendAmount += getProduct.price * orderProduct.amount;
    }

    // 대행주문인 경우 operationUserId 자동 배정
    const operationUserId = clientUserId ? user.id : null;

    // 주문 시점의 사용자/회사 정보 스냅샷 저장
    // 계정관리에서 user 정보가 변경되어도 과거 주문 정보는 당시 값으로 유지
    const userEntity = await this.userRepository.findOneOrFail({
      where: { id: user.id },
      relations: ['company'],
    });
    const clientUserEntity = clientUserId
      ? await this.userRepository.findOneOrFail({
          where: { id: clientUserId },
          relations: ['company'],
        })
      : null;
    // operationUserId는 대행주문 시 user.id와 동일하므로 동일 엔티티 재사용
    const operationUserEntity = operationUserId === user.id ? userEntity : null;

    const orderInsertResult = await this.orderRepository.insert({
      userId: user.id,
      status: IOrderStatus.TEMP,
      code: createTempOrderCode(),
      type,
      eventName,
      sendAmount: sendAmount,
      settleAmount: sendAmount,
      registerAt: new Date(),
      clientUserId,
      operationUserId,
      ...buildOrderUserSnapshot(userEntity),
      ...buildOrderClientUserSnapshot(clientUserEntity),
      ...buildOrderOperationUserSnapshot(operationUserEntity),
    });
    // identifiers 가 누락(undefined)/빈 배열([])/id 부재([{}]) 면 [0] 또는 .id 접근이
    // raw TypeError 를 낸다. ?.[0]?.id 로 모두 undefined 로 좁힌 뒤 명시 가드 →
    // 세 엣지 모두 같은 도메인 에러로 실패(부분주문 방지).
    const orderId: number | undefined = orderInsertResult.identifiers?.[0]?.id;
    if (orderId == null) {
      throw new Error('createTemp: insert 결과에 생성 id가 없어 확정코드를 채번할 수 없습니다');
    }

    // 2-step 채번: id 확정 후 EPEVT 코드로 확정(같은 트랜잭션 → 임시코드 커밋 전 소멸)
    await this.orderRepository.update(orderId, { code: deriveOrderCodeFromId(orderId) });

    const orderDeliveryCreateList: OrderDeliveryEntity[] = [];

    for (const product of orderProductList) {
      const orderProduct = new OrderProductMappingEntity();

      orderProduct.orderId = orderId;
      orderProduct.productId = product.productId;
      orderProduct.amount = product.amount;
      orderProduct.topImagePath = topImagePath ?? OrderService.DEFAULT_TOP_IMAGE_PATH;
      orderProduct.midImagePath = midImagePath ?? OrderService.DEFAULT_MID_IMAGE_PATH;

      // 행별 발송 시각 결정 (다른 행의 시각을 상속하지 않음)
      let productSendAt: Date;
      if (product.sendType === 'IMMEDIATE') {
        productSendAt = new Date();
      } else if (product.sendType === 'RESERVE') {
        if (!product.sendRequestAt) {
          throw new BadRequestException('예약 발송 상품에는 발송 요청 시각이 필요합니다.');
        }
        productSendAt = new Date(product.sendRequestAt);
      } else {
        // 임시저장 draft(sendType 미선택): 다른 행 시각 상속 없이 자체 값 또는 현재 시각 사용
        productSendAt = product.sendRequestAt ? new Date(product.sendRequestAt) : new Date();
      }

      orderProduct.sendMethod = product.sendMethod;
      orderProduct.sendTailText = product.sendTailText;
      orderProduct.requestToDestroyPersonalInfoDay = product.requestToDestroyPersonalInfoDay;
      orderProduct.fromPhoneNumber = product.fromPhoneNumber;
      orderProduct.fromEmail = product.fromEmail;
      orderProduct.sendTitle = product.sendTitle;
      orderProduct.emailSendType = product.emailSendType;
      orderProduct.emailFinalSendMethod = product.emailFinalSendMethod;
      orderProduct.useEmailContent = product.useEmailContent;
      orderProduct.sendContent = product.sendContent;
      orderProduct.sendRequestAt = productSendAt;
      orderProduct.sendType = product.sendType;
      orderProduct.encourageDay = product.encourageDay ?? null;

      // 주문 생성 시점 상품 정보 snapshot 박제
      const liveProduct = productPriceMap.get(product.productId)!;
      const lineSnapshot = buildLineProductSnapshot(liveProduct);
      Object.assign(orderProduct, lineSnapshot);
      Object.assign(
        orderProduct,
        buildPartnerSettleSnapshot(liveProduct, lineSnapshot.snapshotProductPrice ?? liveProduct.price),
      );

      await this.orderProductMappingRepository.save(orderProduct);

      // 상품별 발신 수단 사용
      const deliverySendMethod = orderProduct.sendMethod!;

      for (const orderDelivery of product.orderDeliveryList) {
        const oneOrderDelivery = new OrderDeliveryEntity();
        oneOrderDelivery.orderProductMappingId = orderProduct.id;
        oneOrderDelivery.status = IOrderDeliveryStatus.TEMP;
        oneOrderDelivery.deliveryMethod = deliverySendMethod;
        const encryptedTarget = this.cryptoCipher.encryptDeliveryTarget(
          PhoneUtil.normalizeDeliveryTarget(orderDelivery.deliveryTarget),
        );
        oneOrderDelivery.deliveryTarget = encryptedTarget;
        oneOrderDelivery.originalDeliveryTarget = encryptedTarget;
        oneOrderDelivery.replaceCharacter1 = orderDelivery.replaceCharacter1 ?? null;
        oneOrderDelivery.replaceCharacter2 = orderDelivery.replaceCharacter2 ?? null;
        oneOrderDelivery.replaceCharacter3 = orderDelivery.replaceCharacter3 ?? null;
        oneOrderDelivery.memo = orderDelivery.memo ?? null;
        oneOrderDelivery.sendRequestAt = productSendAt;
        orderDeliveryCreateList.push(oneOrderDelivery);
      }
    }

    await this.orderDeliveryRepository.insert(orderDeliveryCreateList);

    // 수기등록 원본 데이터 저장
    if (getBody.manualEntryList?.length) {
      const manualEntries = this.buildManualEntries(orderId, getBody.manualEntryList);
      await this.orderManualEntryRepository.insert(manualEntries);
    }

    return { id: orderId };
  }

  @Transactional()
  async updateTemp(user: ILoginUserInfo, getBody: OrderUpdateTempReqDto): Promise<void> {
    const { id, eventName, topImagePath, midImagePath, orderProductList } = getBody;

    await this.assertPositiveIntegerAmounts(orderProductList);
    await this.assertNoForbiddenWord(user, orderProductList, id, eventName);

    // 주문 행을 먼저 잠근다. 아래에서 order_product_mapping 도 잠그는데, 락 순서를
    // order -> order_product_mapping -> test_order_delivery 한 방향으로 통일해야
    // order 를 먼저 잠그는 경로(deliveryRequest / deliveryConfirmed)와 데드락 사이클을 만들지 않는다.
    const order = await this.orderRepository
      .createQueryBuilder('order')
      .setLock('pessimistic_write')
      .where('order.id = :id', { id })
      .getOne();

    if (!order) {
      throw new BadRequestException('존재하지 않는 주문입니다.');
    }

    // 최고 관리자 외 타 유저 주문 수정 불가능
    if (user.authority !== IUserAuthority.SUPER_ADMIN && order.userId !== user.id) {
      throw new ForbiddenException('타 유저의 주문입니다.');
    }

    // NOTE: deleteTemp에도 동일한 검증 패턴 존재 — 변경 시 양쪽 모두 업데이트할 것
    if (order.status !== IOrderStatus.TEMP && order.status !== IOrderStatus.DELIVERY_CANCEL) {
      throw new BadRequestException('임시저장 또는 발송취소 상태가 아닐경우 수정할 수 없습니다.');
    }

    // 취소된 주문을 수정하는 경우 상태를 임시저장으로 변경하고 취소 정보 초기화
    const wasCanceled = order.status === IOrderStatus.DELIVERY_CANCEL;
    if (wasCanceled) {
      order.status = IOrderStatus.TEMP;
      order.cancelReason = null;
      order.canceledAt = null;
    }

    // 대행주문인 경우 clientUser의 허용 발신수단으로 검증
    const clientUserId = getBody.clientUserId ?? null;
    await this.validateSendMethods(clientUserId, user.id, orderProductList);

    const ssgReservationRange = order.type === IOrderType.SSG ? await this.ssgEventService.getReservationRange() : null;
    validateSsgReservationWindow(order.type, orderProductList, ssgReservationRange);
    // SSG 주문은 즉시/예약 발송을 혼합할 수 없음 (혼합 시 400). 예약시각은 상품 행별로 달라도 됨
    validateSsgUniformSend(order.type, orderProductList);

    // 동일 productId를 여러 행으로 저장할 수 있으므로 상품 조회는 unique 기준으로 수행
    const uniqueProductIds = [...new Set(orderProductList.map((orderProduct) => orderProduct.productId))];

    const getProductList = await this.productRepository.find({
      where: {
        id: In(uniqueProductIds),
      },
      relations: ['brand', 'partnerCompany', 'partnerCompany.userDiscounts'],
    });

    if (uniqueProductIds.length !== getProductList.length) {
      throw new BadRequestException('존재하지 않는 상품을 추가하였습니다.');
    }
    const productPriceMap = listToMap(getProductList, (product) => product.id);

    const orderId: number = order.id;

    // 수신처 암호화는 매핑 id 와 무관하므로 잠금 전에 끝낸다. 락 구간에서 수천 건을 돌리면
    // 그 시간만큼 테스트 발송의 한도 선점이 대기한다.
    const encryptedTargetsByLine = orderProductList.map((product) =>
      product.orderDeliveryList.map((orderDelivery) =>
        this.cryptoCipher.encryptDeliveryTarget(PhoneUtil.normalizeDeliveryTarget(orderDelivery.deliveryTarget)),
      ),
    );

    // mapping id 소유권/중복 검증 — 헤더 저장 이전에 실행하여 뮤테이션 전 400 보장
    // 행 잠금: 테스트 발송의 한도 선점(test_delivery_count + 1)과 겹치면 승계 과정에서 증가분이 유실된다
    const deleteOrderProductMappingList = await this.orderProductMappingRepository
      .createQueryBuilder('orderProductMapping')
      .setLock('pessimistic_write')
      .where('orderProductMapping.orderId = :orderId', { orderId })
      .getMany();
    const ownedMap = new Map<number, OwnedLine>(
      deleteOrderProductMappingList.map((m) => [
        m.id,
        {
          productId: m.productId,
          testDeliveryCount: m.testDeliveryCount,
          snapshot: {
            snapshotProductPrice: m.snapshotProductPrice,
            snapshotProductName: m.snapshotProductName,
            snapshotProductBrandName: m.snapshotProductBrandName,
            snapshotProductExpireDay: m.snapshotProductExpireDay,
            snapshotProductImagePath: m.snapshotProductImagePath,
            snapshotProductCategory: m.snapshotProductCategory,
            snapshotProductClassificationId: m.snapshotProductClassificationId,
          },
          partnerSettleSnapshot: {
            partnerSettleFee: m.partnerSettleFee,
            partnerSettlePriceAdjustment: m.partnerSettlePriceAdjustment,
          },
        },
      ]),
    );
    assertLineIdsValid(orderProductList, ownedMap);

    // 전송 정산 가격 적용
    // 승계 라인은 기존 snapshot 가격을 사용하여 헤더 금액과 라인 금액이 일치하도록 함
    let sendAmount = 0;
    for (const orderProduct of orderProductList) {
      const getProduct = productPriceMap.get(orderProduct.productId)!;
      const resolvedPrice =
        resolveLineSnapshot(orderProduct, ownedMap, getProduct).snapshotProductPrice ?? getProduct.price;
      sendAmount += resolvedPrice * orderProduct.amount;
    }

    order.eventName = eventName;
    order.sendAmount = sendAmount;
    order.settleAmount = sendAmount;

    // 대행주문 관련 정보 업데이트 — 고객사 변경을 감지해 스냅샷을 재기록한다.
    // 변경이 없으면 기존 스냅샷을 유지한다(계정정보 변경 후 일반수정만으로 덮어쓰지 않음).
    // 레거시 NULL 스냅샷은 여기서 자동 보정하지 않는다(별도 백필/탐지 대상).
    const previousClientUserId = order.clientUserId ?? null;
    const clientChanged = previousClientUserId !== clientUserId;
    order.clientUserId = clientUserId;

    if (clientChanged) {
      const nextClientUser =
        clientUserId != null
          ? await this.userRepository.findOneOrFail({ where: { id: clientUserId }, relations: ['company'] })
          : null;
      const operationUser =
        clientUserId != null ? await this.userRepository.findOneOrFail({ where: { id: user.id } }) : null;

      const transition = buildClientAssignmentTransition({
        previousClientUserId,
        nextClientUserId: clientUserId,
        nextClientUser,
        operationUser,
      });
      if (transition) {
        Object.assign(order, transition);
      }
    }

    await this.orderRepository.save(order);

    // 2. 기존 order product, delivery 삭제
    const deleteOrderProductIdList = deleteOrderProductMappingList.map((orderProduct) => orderProduct.id);
    await this.orderProductMappingRepository.delete({ id: In(deleteOrderProductIdList) });
    await this.orderDeliveryRepository.delete({ orderProductMappingId: In(deleteOrderProductIdList) });
    // 수기등록 원본 데이터 삭제
    await this.orderManualEntryRepository.delete({ orderId });

    // 3. 신규 order delivery, product 생성
    const orderDeliveryCreateList: OrderDeliveryEntity[] = [];

    for (const [lineIndex, product] of orderProductList.entries()) {
      const orderProduct = new OrderProductMappingEntity();

      orderProduct.orderId = orderId;
      orderProduct.productId = product.productId;
      orderProduct.amount = product.amount;
      orderProduct.topImagePath = topImagePath ?? OrderService.DEFAULT_TOP_IMAGE_PATH;
      orderProduct.midImagePath = midImagePath ?? OrderService.DEFAULT_MID_IMAGE_PATH;

      // 행별 발송 시각 결정 (다른 행의 시각을 상속하지 않음)
      let productSendAt: Date;
      if (product.sendType === 'IMMEDIATE') {
        productSendAt = new Date();
      } else if (product.sendType === 'RESERVE') {
        if (!product.sendRequestAt) {
          throw new BadRequestException('예약 발송 상품에는 발송 요청 시각이 필요합니다.');
        }
        productSendAt = new Date(product.sendRequestAt);
      } else {
        // 임시저장 draft(sendType 미선택): 다른 행 시각 상속 없이 자체 값 또는 현재 시각 사용
        productSendAt = product.sendRequestAt ? new Date(product.sendRequestAt) : new Date();
      }

      orderProduct.sendMethod = product.sendMethod;
      orderProduct.sendTailText = product.sendTailText;
      orderProduct.requestToDestroyPersonalInfoDay = product.requestToDestroyPersonalInfoDay;
      orderProduct.fromPhoneNumber = product.fromPhoneNumber;
      orderProduct.fromEmail = product.fromEmail;
      orderProduct.sendTitle = product.sendTitle;
      orderProduct.emailSendType = product.emailSendType;
      orderProduct.emailFinalSendMethod = product.emailFinalSendMethod;
      orderProduct.useEmailContent = product.useEmailContent;
      orderProduct.sendContent = product.sendContent;
      orderProduct.sendRequestAt = productSendAt;
      orderProduct.sendType = product.sendType;
      orderProduct.encourageDay = product.encourageDay ?? null;

      const liveProduct = productPriceMap.get(product.productId)!;
      const lineSnapshot = resolveLineSnapshot(product, ownedMap, liveProduct);
      Object.assign(orderProduct, lineSnapshot);
      Object.assign(
        orderProduct,
        resolvePartnerSettleSnapshotForUpdate(
          product,
          ownedMap,
          liveProduct,
          lineSnapshot.snapshotProductPrice ?? liveProduct.price,
        ),
      );

      const carriedLineId = resolveCarriedLineId(product, ownedMap);

      // 초기화하면 저장할 때마다 상품 행당 2회 제한이 풀린다
      orderProduct.testDeliveryCount =
        carriedLineId != null ? (ownedMap.get(carriedLineId)?.testDeliveryCount ?? 0) : 0;

      await this.orderProductMappingRepository.save(orderProduct);

      // 테스트 발송 이력을 신규 매핑으로 승계 (매핑 id 가 바뀌어도 조회가 끊기지 않도록)
      // soft-delete 된 이력도 함께 옮긴다. 조회는 deleted_at IS NULL 이라 되살아나지 않는다.
      if (carriedLineId != null) {
        await this.testOrderDeliveryRepository.update(
          { orderProductMappingId: carriedLineId },
          { orderProductMappingId: orderProduct.id },
        );
      }

      // 상품별 발신 수단 사용
      const deliverySendMethod = orderProduct.sendMethod!;

      const encryptedTargets = encryptedTargetsByLine[lineIndex];

      product.orderDeliveryList.forEach((orderDelivery, deliveryIndex) => {
        const oneOrderDelivery = new OrderDeliveryEntity();
        oneOrderDelivery.orderProductMappingId = orderProduct.id;
        oneOrderDelivery.status = IOrderDeliveryStatus.TEMP;
        oneOrderDelivery.deliveryMethod = deliverySendMethod;
        const encryptedTarget = encryptedTargets[deliveryIndex];
        oneOrderDelivery.deliveryTarget = encryptedTarget;
        oneOrderDelivery.originalDeliveryTarget = encryptedTarget;
        oneOrderDelivery.replaceCharacter1 = orderDelivery.replaceCharacter1 ?? null;
        oneOrderDelivery.replaceCharacter2 = orderDelivery.replaceCharacter2 ?? null;
        oneOrderDelivery.replaceCharacter3 = orderDelivery.replaceCharacter3 ?? null;
        oneOrderDelivery.memo = orderDelivery.memo ?? null;
        oneOrderDelivery.sendRequestAt = productSendAt;
        orderDeliveryCreateList.push(oneOrderDelivery);
      });
    }

    await this.orderDeliveryRepository.insert(orderDeliveryCreateList);

    // 삭제되거나 상품이 교체된 라인의 이력은 승계처가 없다. 남겨두면 조회 불가능한 행으로 누적된다
    const carriedLineIds = new Set(
      orderProductList
        .map((product) => resolveCarriedLineId(product, ownedMap))
        .filter((lineId): lineId is number => lineId != null),
    );
    const orphanedLineIds = [...ownedMap.keys()].filter((lineId) => !carriedLineIds.has(lineId));
    if (orphanedLineIds.length) {
      // WAIT 은 외부 발송이 이미 나갔을 수 있어 지우지 않는다(ERP 197-15 방침).
      // 매핑이 곧 삭제되면 discardStaleTestDeliveries 가 이 행에 도달할 수 없으므로
      // 아직 매핑 id 로 특정 가능한 지금 경보를 남긴다.
      const escalated = await this.testOrderDeliveryRepository
        .createQueryBuilder()
        .update()
        .set({ opsEscalatedAt: () => 'NOW()' })
        .where('order_product_mapping_id IN (:...orphanedLineIds)', { orphanedLineIds })
        .andWhere('status = :wait', { wait: IOrderDeliveryStatus.WAIT })
        .andWhere('deleted_at IS NULL')
        .andWhere('ops_escalated_at IS NULL')
        .execute();

      if ((escalated.affected ?? 0) > 0) {
        this.logger.error(
          `테스트 발송 여부 불명 ${escalated.affected}건이 매핑 삭제로 고아가 됨 — 운영 확인 필요 (orderId: ${orderId}, orderProductMappingIds: ${orphanedLineIds.join(',')})`,
        );
      }

      await this.testOrderDeliveryRepository.softDelete({
        orderProductMappingId: In(orphanedLineIds),
        status: Not(IOrderDeliveryStatus.WAIT),
      });
    }

    // 수기등록 원본 데이터 재생성
    if (getBody.manualEntryList?.length) {
      const manualEntries = this.buildManualEntries(orderId, getBody.manualEntryList);
      await this.orderManualEntryRepository.insert(manualEntries);
    }

    return;
  }

  @Transactional()
  async deleteTemp(user: ILoginUserInfo, getBody: OrderDeleteTempReqDto): Promise<void> {
    const { id } = getBody;

    // NOTE: updateTemp에도 동일한 검증 패턴 존재 — 변경 시 양쪽 모두 업데이트할 것
    const order = await this.orderRepository.findOne({
      where: {
        id: id,
      },
    });

    if (!order) {
      throw new BadRequestException('존재하지 않는 주문입니다.');
    }

    if (user.authority !== IUserAuthority.SUPER_ADMIN && order.userId !== user.id) {
      throw new ForbiddenException('타 유저의 주문입니다.');
    }

    if (order.status !== IOrderStatus.TEMP && order.status !== IOrderStatus.DELIVERY_CANCEL) {
      throw new BadRequestException('임시저장 또는 발송취소 상태가 아닌 주문은 삭제할 수 없습니다.');
    }

    // 2. 주문 자체 soft delete (deleted_at에 now() 기록)
    await this.orderRepository.softDelete({ id });

    // 3. 연관된 자식 테이블 soft delete
    // 3-1. order_product_mapping
    const mappingList = await this.orderProductMappingRepository.find({
      where: { orderId: id },
    });

    if (mappingList.length > 0) {
      const mappingIds = mappingList.map((mp) => mp.id);

      // 3-2. order_delivery는 삭제하지 않음
      // - 테스트 발송 후 coupon-view 페이지에서 쿠폰 조회가 가능해야 함
      // - 다른 조회에서는 INNER JOIN 또는 deletedAt 필터로 자연 제외됨

      // 3-3. order_product_mapping soft delete
      await this.orderProductMappingRepository.softDelete({
        id: In(mappingIds),
      });
    }

    // 수기등록 원본 데이터 삭제
    await this.orderManualEntryRepository.delete({ orderId: id });

    return;
  }

  async getManualEntries(user: ILoginUserInfo, orderId: number): Promise<ManualEntryViewDto[]> {
    const order = await this.orderRepository.findOne({
      where: { id: orderId },
      select: ['id', 'userId'],
    });
    if (!order) {
      throw new BadRequestException('존재하지 않는 주문입니다.');
    }
    if (user.authority !== IUserAuthority.SUPER_ADMIN && order.userId !== user.id) {
      throw new ForbiddenException('해당 주문에 대한 권한이 없습니다.');
    }

    const entries = await this.orderManualEntryRepository.find({
      where: { orderId },
      order: { rowIndex: 'ASC' },
    });
    return entries.map((entry) => ({
      rowIndex: entry.rowIndex,
      phoneNumber: this.cryptoCipher.safeDecryptDeliveryTarget(entry.phoneNumber) ?? '',
      sendAmount: entry.sendAmount,
      replaceCharacter1: entry.replaceCharacter1,
      replaceCharacter2: entry.replaceCharacter2,
      replaceCharacter3: entry.replaceCharacter3,
      memo: entry.memo,
    }));
  }

  /**
   * 잔액·한도를 바꾸는 발송 경로의 공통 잠금 범위.
   *
   * COMPANY 모드는 회사 row를 mutex로 먼저 확보하고, 이어 모든 회사 사용자를
   * ID 오름차순으로 잠근다. 이 순서는 deliveryRequest/deliveryConfirmed가
   * 동일하게 사용해야 서로 다른 사용자의 동시 발송에서도 순환 대기가 생기지 않는다.
   */
  private async lockBillingScope(billingUserId: number): Promise<{ user: UserEntity; companyUsers: UserEntity[] }> {
    return this.billingScopeLockService.lock(billingUserId);
  }

  @Transactional()
  async deliveryRequest(user: ILoginUserInfo, getBody: OrderDeliveryRequestReqDto): Promise<void> {
    const { id } = getBody;

    this.logger.log(`[deliveryRequest] 요청 - orderId: ${id}, userId: ${user.id}`);

    const order = await this.orderRepository
      .createQueryBuilder('order')
      .setLock('pessimistic_write')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.id = :id', { id })
      .andWhere('order.userId = :userId', { userId: user.id })
      .andWhere('order.status = :status', { status: IOrderStatus.TEMP })
      .getOne();

    this.logger.log(`[deliveryRequest] 조회 결과 - order: ${order ? order.id : 'null'}`);

    if (!order) {
      throw new BadRequestException('해당 주문건은 존재하지 않거나, 임시저장 상태가 아닙니다.');
    }

    if (!order.orderProductMappings || order.orderProductMappings.length === 0) {
      throw new BadRequestException('발송 상세를 입력하지 않았습니다.');
    }

    for (const orderMapping of order.orderProductMappings!) {
      if (!orderMapping.orderDeliveries || orderMapping.orderDeliveries.length === 0) {
        throw new BadRequestException('발송 상세를 입력하지 않았습니다.');
      }
    }

    // 발송요청 직전 금칙어 최종 차단(저장된 콘텐츠 기준, sendTitle 포함)
    await this.assertNoForbiddenWordInOrder(user, order);

    const ssgReservationRange = order.type === IOrderType.SSG ? await this.ssgEventService.getReservationRange() : null;
    validateSsgReservationWindow(order.type, order.orderProductMappings!, ssgReservationRange);
    // 실발송 직전: 모든 행의 sendType 확정 + RESERVE 행 sendRequestAt 필수 (null 행이 즉시발송으로 잘못 차감되는 것 방지)
    validateDeliverySendTypes(order.orderProductMappings!);

    OrderValidation(order);

    if (process.env.FROM_PHONE_SOT_ENFORCE === 'true') {
      await this.orderFromService.assertApprovedPhones(getBillingUserId(order), order.orderProductMappings!);
    }

    // 총 주문 금액
    const totalAmount = order.orderProductMappings.reduce((sum, m) => {
      if (!m.product) {
        throw new BadRequestException('상품 정보가 존재하지 않습니다.');
      }
      return sum + m.product.price * m.amount;
    }, 0);
    this.logger.debug(`User#${user.id} totalAmount=${totalAmount}`);

    // 과금 대상 userId 결정 (대행주문인 경우 clientUserId, 아니면 userId)
    const billingUserId = order.clientUserId ?? order.userId;
    this.logger.debug(
      `Billing User ID: ${billingUserId} (clientUserId: ${order.clientUserId}, userId: ${order.userId})`,
    );

    const { user: oneUser, companyUsers } = await this.lockBillingScope(billingUserId);

    // PR-B settlement_code 가드 (WALLET 흐름 전용, 기본 OFF/DARK).
    // 코드 미부여(빈 문자열/null) 상태로 발송요청 제출을 차단. legacy 흐름은 미적용.
    if (
      order.isNewBillingFlow &&
      (oneUser.settlementCode == null || oneUser.settlementCode === '') &&
      this.walletCutoverConfig.settlementCodeGuardEnforced
    ) {
      throw new SettlementCodeRequiredError();
    }

    // 과금 모드 결정 (두 블록에서 공통 사용)
    const isCompanyBalanceMode = oneUser.company?.balanceManagementType === 'COMPANY';
    const effectiveBalance = isCompanyBalanceMode && oneUser.company ? oneUser.company.balance : oneUser.balance;

    if (!order.isNewBillingFlow) {
      // === 기존 흐름: 발송요청 시 잔액/한도 체크 ===
      let remainServiceAmount: number;
      if (oneUser.companyId && oneUser.company) {
        const totalAllSettleAmount = companyUsers.reduce((sum, u) => sum + u.allSettleAmount, 0);
        remainServiceAmount = oneUser.company.maximumLimit + effectiveBalance - totalAllSettleAmount;
      } else {
        remainServiceAmount = effectiveBalance - oneUser.allSettleAmount;
      }

      if (totalAmount > remainServiceAmount) {
        throw new BadRequestException('최대 서비스 한도를 넘어 요청할 수 없습니다.');
      }
    }
    // 새 흐름(isNewBillingFlow=true): 발송요청 시 잔액/한도 체크 없음 (발송확정 시 차감)

    // 신세계 상품 검증 및 이벤트 자동 선택 (배송건별 행사 분할 할당)
    let ssgAllocations: { deliveryId: number; eventId: number; price: number }[] | null = null;

    if (order.type === IOrderType.SSG) {
      // 즉시/예약 발송 혼합 금지 검증 (혼합 시 400) — 배포 전 생성된 혼합 주문 방어 포함
      validateSsgUniformSend(order.type, order.orderProductMappings!);

      // expireDay(상품 유효기간)는 모든 SSG mapping이 동일해야 대표값을 전체에 적용 가능
      // 배송건 수집과 유효기간 검증을 단일 루프에서 처리
      const expireDays = new Set<number>();
      const deliveries: { deliveryId: number; price: number; reserveDate?: Date }[] = [];
      for (const orderMapping of order.orderProductMappings!) {
        if (!orderMapping.product) {
          throw new BadRequestException('상품 정보가 존재하지 않습니다.');
        }
        expireDays.add(orderMapping.product.expireDay);
        const price = orderMapping.product.price;
        // 상품 행별 예약시각: RESERVE면 해당 mapping의 sendRequestAt, 아니면 즉시발송(폴백=현재 시각)
        const mappingReserveDate =
          orderMapping.sendType === 'RESERVE' && orderMapping.sendRequestAt
            ? new Date(orderMapping.sendRequestAt as unknown as string)
            : undefined;
        for (const orderDelivery of orderMapping.orderDeliveries) {
          deliveries.push({ deliveryId: orderDelivery.id, price, reserveDate: mappingReserveDate });
        }
      }
      if (expireDays.size > 1) {
        throw new BadRequestException('SSG 주문의 상품 유효기간은 모든 상품 행에서 동일해야 합니다.');
      }
      const couponExpiration = order.orderProductMappings![0].product!.expireDay;

      // 배송건별 행사 할당: 각 배송건은 자신의 예약시각(reserveDate) 기준으로 유효한 행사에 매칭 (All or Nothing)
      ssgAllocations = await this.ssgEventService.allocateEventsForDeliveries(deliveries, couponExpiration);

      if (!ssgAllocations) {
        throw new BadRequestException('사용 가능한 SSG 이벤트가 없습니다. (잔액 부족)');
      }

      // 첫 번째 할당된 행사 ID를 주문에 저장 (대표 행사)
      order.ssgEventId = ssgAllocations.length > 0 ? ssgAllocations[0].eventId : null;

      // 여러 행사에서 분할 차감 (isTemporary = true)
      await this.ssgEventService.deductEventBalanceMultiple(ssgAllocations, order.id, true);
    }

    // 배송건 저장 및 SSG 행사 할당
    const allocationMap = new Map<number, number>();
    if (ssgAllocations) {
      for (const alloc of ssgAllocations) {
        allocationMap.set(alloc.deliveryId, alloc.eventId);
      }
    }

    for (const orderMapping of order.orderProductMappings!) {
      for (const orderDelivery of orderMapping.orderDeliveries) {
        orderDelivery.transactionId = CreateTransactionId(order.id, orderDelivery.id);

        // SSG 주문인 경우 배송건에 할당된 행사 ID 저장
        if (order.type === IOrderType.SSG && allocationMap.has(orderDelivery.id)) {
          orderDelivery.ssgEventId = allocationMap.get(orderDelivery.id) || null;
        }

        await this.orderDeliveryRepository.save(orderDelivery);
      }
    }

    if (!order.isNewBillingFlow) {
      // === 기존 흐름: 발송요청 시 잔액 차감 ===
      if (totalAmount > effectiveBalance) {
        oneUser.allSettleAmount += totalAmount;
        order.isSettleBalance = false;
      } else {
        if (isCompanyBalanceMode && oneUser.company) {
          oneUser.company.balance -= totalAmount;
        } else {
          oneUser.balance -= totalAmount;
        }
        order.isSettleBalance = true;
      }

      await this.userRepository.save(oneUser);
      if (isCompanyBalanceMode && oneUser.company) {
        await this.userCompanyRepository.save(oneUser.company);
      }
    }
    // 새 흐름: 잔액 차감 없음 (발송확정 시 처리)

    order.status = IOrderStatus.DELIVERY_REQUEST;
    await this.orderRepository.save(order);

    return;
  }

  @Transactional()
  async reviewComplete(user: ILoginUserInfo, getBody: OrderReviewCompleteReqDto): Promise<void> {
    const { id } = getBody;

    const order = await this.orderRepository
      .createQueryBuilder('order')
      .where('order.id = :id', { id })
      .andWhere('order.status = :status', { status: IOrderStatus.DELIVERY_REQUEST })
      .getOne();

    if (!order) {
      throw new BadRequestException('해당 주문건은 존재하지 않거나, 주문완료 상태가 아닙니다.');
    }

    const currentUser = await this.getCurrentDeliveryTransitionUser(user.id);
    if (!canTransitionDelivery(currentUser, order)) {
      throw new ForbiddenException('해당 주문에 대한 권한이 없습니다.');
    }

    order.status = IOrderStatus.REVIEW_COMPLETE;
    await this.orderRepository.save(order);

    return;
  }

  /**
   * 발송확정 공통 command.
   *
   * 사용자 호출(컨트롤러)과 신용초과 승인 실행(CreditExcessApprovalDispatchService)이 같은 경로를 쓴다.
   * `approvalContext` 가 있으면 서버 승인 실행이며, 트랜잭션 시작 시 approval row 를 FOR UPDATE 로
   * 잠그고 PROCESSING/fencing token 을 검증한 뒤 스냅샷 재검증·실행 표식 기록까지 같은 트랜잭션에서 수행한다.
   */
  @Transactional()
  async deliveryConfirmed(
    user: ILoginUserInfo,
    getBody: OrderDeliveryConfirmedReqDto,
    approvalContext?: CreditExcessApprovalExecutionContext,
  ): Promise<OrderDeliveryConfirmed> {
    const { id } = getBody;

    if (approvalContext) {
      await this.creditExcessApprovalService.lockProcessing(
        this.orderRepository.manager,
        approvalContext.approvalId,
        approvalContext.attemptToken,
      );
    }

    const lockedOrder = await this.orderRepository
      .createQueryBuilder('order')
      .setLock('pessimistic_write')
      .where('order.id = :id', { id })
      // .andWhere('order.userId = :userId', { userId: user.id })
      .andWhere('order.status = :status', { status: IOrderStatus.REVIEW_COMPLETE })
      .getOne();

    if (!lockedOrder) {
      throw new BadRequestException('해당 주문건은 존재하지 않거나, 검토완료 상태가 아닙니다.');
    }

    const currentUser = await this.getCurrentDeliveryTransitionUser(user.id);
    if (!canTransitionDelivery(currentUser, lockedOrder)) {
      throw new ForbiddenException('해당 주문에 대한 권한이 없습니다.');
    }

    const order = await this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.product', 'product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.classification', 'classification')
      .innerJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.id = :id', { id })
      // .andWhere('order.userId = :userId', { userId: user.id })
      .andWhere('order.status = :status', { status: IOrderStatus.REVIEW_COMPLETE })
      .getOne();

    if (!order) {
      throw new BadRequestException('해당 주문건은 존재하지 않거나, 검토완료 상태가 아닙니다.');
    }

    OrderValidation(order);

    // wallet 전용 결제 파라미터(포인트/예치금 사용)는 WALLET 모드에서만 소비된다.
    // isNewBillingFlow 분기와 무관하게 발송확정 공통 경로에서 LEGACY/SHADOW 수신 시 400 거부.
    assertWalletOnlyParamsAbsent(this.walletCutoverConfig.pr2DeliveryLifecycleMode, getBody);

    if (process.env.FROM_PHONE_SOT_ENFORCE === 'true') {
      await this.orderFromService.assertApprovedPhones(getBillingUserId(order), order.orderProductMappings!);
    }

    // 신세계 상품 검증 (confirmEventBalance는 한도 체크 이후에 실행)
    if (order.type === IOrderType.SSG) {
      const hasSsgEvent = order.orderProductMappings!.some((mapping) =>
        mapping.orderDeliveries.some((delivery) => delivery.ssgEventId != null),
      );

      if (!hasSsgEvent) {
        throw new BadRequestException('SSG 이벤트가 선택되지 않았습니다.');
      }
    }

    let message = 'success';
    // WALLET 모드 분배 결과 (요청2 success 응답 분배 상세). LEGACY/SHADOW 는 null → 0 통일.
    let walletAllocation: AllocationResult | null = null;

    // 과금 대상 userId 결정 (대행주문인 경우 clientUserId, 아니면 userId)
    const billingUserId = order.clientUserId ?? order.userId;

    // 사용자 정보 조회 (중복번호 체크 및 잔액 조정에 필요) + 동시 잔액 조작 방지용 pessimistic lock
    const { user: oneUser, companyUsers } = await this.lockBillingScope(billingUserId);

    // balanceManagementType에 따른 balance 관리 모드 결정
    const isCompanyBalanceMode = oneUser.company?.balanceManagementType === 'COMPANY';

    // ======== 할인/할증 차액 정산 시작 ========
    // 발송요청 시 정가(sendAmount)로 차감되었으므로, 발송확정 시 최종 정산금액과의 차액을 조정
    const userDiscounts = (
      await this.userDiscountRepository.find({
        where: { userId: billingUserId },
      })
    ).filter((discount) => discount.userId === billingUserId);

    const mappingsToUpdate: OrderProductMappingEntity[] = [];
    // 정산 자동캡처 이력: 할인 자동 매칭 전 스냅샷 (아래 loop 가 mapping.fee 를 mutate 하므로 이 시점 캡처).
    const autoSettleSnapshot = this.captureSettleSnapshot(order.orderProductMappings!);

    // 각 매핑별 할인/할증 상태 저장 (중복번호 체크에 사용)
    const mappingPriceAdjustments = new Map<number, IPriceAdjustment | null>();

    const { mappingsToUpdate: autoMatched, mappingPriceAdjustments: matchedAdjustments } =
      this.applyAutoDiscountMatching(order, userDiscounts);
    mappingsToUpdate.push(...autoMatched);
    for (const [mappingId, adjustment] of matchedAdjustments) {
      mappingPriceAdjustments.set(mappingId, adjustment);
    }

    // 업데이트할 매핑이 있으면 저장
    if (mappingsToUpdate.length > 0) {
      await this.orderProductMappingRepository.save(mappingsToUpdate);
    }

    await this.logSettleDiscountChange({
      user,
      orderId: order.id,
      requestUrl: '/order/delivery-confirmed',
      method: 'POST',
      source: SettleDiscountChangeSource.AUTO_CONFIRM,
      changes: buildSettleDiscountChanges(
        autoSettleSnapshot.beforeById,
        mappingsToUpdate,
        autoSettleSnapshot.productNameById,
      ),
    });

    // ======== 중복번호 제어 체크 시작 ========
    // 할인 적용 → 1건만 허용 (중복 불가)
    // 할인/할증 없음 → duplicatePhoneLimit 만큼 허용 (0이면 무제한)
    // 할증 적용 → 무제한
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // productId별 그룹 제한 결정 (같은 productId 여러 mapping 중 가장 엄격한 유한 제한 사용)
    //  - ADDITIONAL(할증): 무제한
    //  - DISCOUNT(할인): CS팀 요청으로 개방 중 — 무제한 취급 (c7871f4, 2026-01-27).
    //    원칙은 동일번호 1건 제한이며 CS팀이 재차 요청할 때만 복구 (복구 시 allowedCount=1 후보 추가)
    //  - 할인/할증 없음: duplicatePhoneLimit (0이면 무제한)
    // 유한 후보가 하나도 없으면(모두 무제한) 해당 productId 그룹은 검사 생략.
    const productLimit = resolveProductDuplicateLimit(
      order.orderProductMappings!,
      mappingPriceAdjustments,
      oneUser.duplicatePhoneLimit,
    );

    // 현재 주문 내 productId + 수신처(정규화·암호화된 값) 기준 합산 count
    // 무제한 mapping(ADDITIONAL 등)의 배송건도 같은 productId에 유한 제한이 있으면 합산 대상에 포함
    const currentGroupCount = new Map<number, Map<string, number>>();
    for (const orderMapping of order.orderProductMappings!) {
      let targetCounts = currentGroupCount.get(orderMapping.productId);
      if (!targetCounts) {
        targetCounts = new Map<string, number>();
        currentGroupCount.set(orderMapping.productId, targetCounts);
      }
      for (const od of orderMapping.orderDeliveries) {
        targetCounts.set(od.deliveryTarget, (targetCounts.get(od.deliveryTarget) || 0) + 1);
      }
    }

    // 그룹별 제한 검증 (기존 주문 + 현재 주문 합산)
    const duplicateErrors: string[] = [];
    for (const [productId, targetCounts] of currentGroupCount.entries()) {
      const allowedCount = productLimit.get(productId);
      if (allowedCount === undefined) continue; // 무제한 그룹

      for (const [target, currentCount] of targetCounts.entries()) {
        // 하루 기준 동일상품 동일수신처 발송 횟수 (기존 주문)
        const existingCount = await this.orderDeliveryRepository
          .createQueryBuilder('od')
          .innerJoin('od.orderProductMapping', 'opm')
          .innerJoin('opm.order', 'o')
          .where('o.userId = :userId', { userId: order.userId })
          .andWhere('opm.productId = :productId', { productId })
          .andWhere('od.deliveryTarget = :deliveryTarget', { deliveryTarget: target })
          .andWhere('o.id != :currentOrderId', { currentOrderId: order.id })
          .andWhere('o.status IN (:...statuses)', {
            statuses: [IOrderStatus.DELIVERY_CONFIRMED, IOrderStatus.DELIVERY_COMPLETE],
          })
          .andWhere('o.createdAt >= :todayStart', { todayStart })
          .andWhere('o.createdAt <= :todayEnd', { todayEnd })
          .getCount();

        const totalCount = existingCount + currentCount;
        const displayPhone = this.cryptoCipher.safeDecryptDeliveryTarget(target) ?? target;

        this.logger.debug(
          `중복 체크: 상품=${productId}, 수신처=${displayPhone}, 기존=${existingCount}, 현재=${currentCount}, 합계=${totalCount}, 허용=${allowedCount}`,
        );

        if (totalCount > allowedCount) {
          duplicateErrors.push(
            `- ${displayPhone}: 금일 ${existingCount}건 발송 + 현재 ${currentCount}건 = 총 ${totalCount}건 (허용: ${allowedCount}건)`,
          );
        }
      }
    }

    // 중복 에러가 있으면 발송 거절
    if (duplicateErrors.length > 0) {
      throw new BadRequestException(
        `일반 상품의 중복발송 제한을 초과한 수신처가 발견되었습니다:\n\n${duplicateErrors.join('\n')}`,
      );
    }
    // ======== 중복번호 제어 체크 끝 ========

    // 미정산 주문은 확정 시점 정책을 주문 스냅샷으로 고정해 allocation/조회/재정산의 기준을 일치시킨다.
    const settleOrderBefore: SettleOrderSnapshot = {
      settleMethod: order.settleMethod,
      cardSurchargeApplied: order.cardSurchargeApplied,
    };
    const hasSettleInput = order.settleMethod != null;
    const resolvedSettlePolicy = hasSettleInput ? null : await this.resolveSettlePolicy(order, oneUser.company);
    const effectiveSettleMethod = order.settleMethod ?? resolvedSettlePolicy?.policy ?? 'CASH';
    const effectiveSurcharge = hasSettleInput
      ? order.cardSurchargeApplied
      : effectiveSettleMethod === 'CARD' && (resolvedSettlePolicy?.resolvedWallet?.cardSurchargeApplied ?? true);
    const finalAmount = calculateOrderSettlementAmount(order, effectiveSurcharge);

    if (order.isNewBillingFlow) {
      // === 새 흐름: 발송확정 시 전액 차감 ===

      // 1. effectiveBalance 결정
      const effectiveBalance = isCompanyBalanceMode && oneUser.company ? oneUser.company.balance : oneUser.balance;

      // 2. 잔여한도 계산
      let remainServiceAmount: number;
      if (oneUser.companyId && oneUser.company) {
        const totalAllSettleAmount = companyUsers.reduce((sum, u) => sum + u.allSettleAmount, 0);
        remainServiceAmount = oneUser.company.maximumLimit + effectiveBalance - totalAllSettleAmount;
      } else {
        remainServiceAmount = effectiveBalance - oneUser.allSettleAmount;
      }

      // 3-2. Wallet Cutover Bundle (PR2-005) 모드 게이트 (Step B/D 사전 체크 위해 먼저 결정)
      const cutoverMode = this.walletCutoverConfig.pr2DeliveryLifecycleMode;

      // 3. 신용초과 분기 + 분배 계산
      //  - WALLET: allocate() 를 먼저 계산하고 allocation.creditExcessAmount 기준으로 신용초과 판정
      //    (포인트/예치금 입력으로 초과가 해소되면 승인 워크플로 미트리거 — 요청4 판정 이동).
      //  - LEGACY/SHADOW: 기존 finalAmount > remainServiceAmount 기준 유지 (else 브랜치).
      if (cutoverMode === WalletCutoverMode.WALLET) {
        // === WALLET: wallet primary + legacy mirror (user.balance 미기록) ===
        // typeorm-transactional cls TX 안에서 동작 — manager 공유로 same-tx 보장
        const externalManager = this.orderRepository.manager;

        // 멱등 가드: 이미 wallet-managed (released_at IS NULL) → 재호출 차단
        const alreadyManaged = await this.walletManagedPredicate.isWalletManaged(order.id, externalManager);
        if (alreadyManaged) {
          throw new BadRequestException('order already wallet-confirmed');
        }

        const wallet = await this.walletAccountResolverService.resolveForOrder(order, externalManager);
        const allocationInput = await this.walletAllocationInputBuilder.build(order, wallet, finalAmount, {
          requestedPointAmount: getBody.pointUseAmount,
          depositUseEnabled: getBody.depositUseEnabled,
          depositUseAmount: getBody.depositUseAmount,
          companyId: oneUser.companyId,
          cardSurchargeApplied: effectiveSurcharge,
        });
        // 사용액 입력 검증 (clamp 금지 — 사용 가능 한도 초과 시 400)
        this.assertUsageWithinLimits(allocationInput, getBody);
        const allocation = this.paymentAllocationService.allocate(allocationInput);

        // 승인 실행이면 요청 시점 스냅샷과 현재 재계산 결과를 같은 잠금 범위에서 비교한다.
        if (approvalContext) {
          this.assertApprovalSnapshotMatches(
            approvalContext,
            buildCreditExcessSnapshot({
              order,
              lifecycleMode: cutoverMode,
              billingUserId,
              walletAccountId: String(wallet.id),
              settleMethod: effectiveSettleMethod,
              cardSurchargeApplied: effectiveSurcharge,
              finalAmount,
              remainServiceAmount,
              excessAmount: allocation.creditExcessAmount,
              payableSettlementAmount: allocation.payableSettlementAmount,
              usage: getBody,
              allocation: {
                pointUsedAmount: allocation.pointUsedAmount,
                depositUsedAmount: allocation.depositUsedAmount,
                creditUsedAmount: allocation.creditUsedAmount,
                creditExcessAmount: allocation.creditExcessAmount,
                cardSurchargeAmount: allocation.cardSurchargeAmount,
              },
            }),
          );
        }

        // 신용초과 판정 = allocation.creditExcessAmount 기준 (finalAmount 아님)
        if (allocation.creditExcessAmount > 0) {
          if (!approvalContext) {
            // 사용자 호출: 신용초과 승인 요청 안내 응답 (SSG confirmEventBalance 미실행, DB 차감 없음).
            // 사용자 재시도 발송확정은 없다 — 운영자 승인 시 서버가 직접 확정한다.
            return {
              message: 'credit_excess',
              creditExcess: true,
              excessAmount: allocation.creditExcessAmount,
              remainServiceAmount,
              finalAmount: allocation.payableSettlementAmount,
              ...this.allocationDetail(allocation),
            } as OrderDeliveryConfirmed;
          }
          order.isCreditExcess = true;
          this.logger.warn(
            `신용초과 발송확정(승인 실행): orderId=${order.id}, approvalId=${approvalContext.approvalId}, 초과액=${allocation.creditExcessAmount.toLocaleString()}원, 결제=${allocation.payableSettlementAmount.toLocaleString()}원`,
          );
        }

        // 3-1. SSG 가차감 확정 (진행 결정 + 사전 승인 통과 후에만 실행)
        if (order.type === IOrderType.SSG) {
          await this.ssgEventService.confirmEventBalance(order.id);
        }

        // 신용초과 승인 실행이면 approvalId 를 넘겨 persistAllocation 안에서 same-tx 로 consume 한다.
        // 사용자 호출은 항상 null — 신용초과가 남아 있으면 위에서 이미 승인 요청 안내로 반환된다.
        const deliveryIdsForAttempt: number[] = [];
        for (const mapping of order.orderProductMappings!) {
          for (const delivery of mapping.orderDeliveries) {
            deliveryIdsForAttempt.push(delivery.id);
          }
        }

        const persistResult = await this.orderConfirmationWalletService.persistAllocation(
          {
            orderId: order.id,
            allocation,
            cardSurchargeAppliedSnapshot: effectiveSurcharge,
            hasDiscountSnapshot: allocation.hasDiscount,
            settleMethodSnapshot: effectiveSettleMethod,
            deliveryIdsForAttempt,
            creditExcessApprovalId: approvalContext?.approvalId ?? null,
          },
          externalManager,
        );
        // persistAllocation 이 lock 후 재계산한 최종 allocation 사용 (pre-lock allocation 은 stale 가능).
        const finalAllocation = persistResult.finalAllocation;

        // persistAllocation 이 lock 후 예치금 부족분을 credit/credit_excess 로 재분배할 수 있다.
        // consume() 는 총 결제액·신용초과액만 비교하므로, "총액·excess 는 동일하지만 deposit↓/credit↑"
        // 같은 재분배는 걸러내지 못한다 → 승인받은 배분과 다른 배분으로 확정될 수 있다.
        // 최종 allocation 으로 스냅샷을 다시 구성해 전체(재원 배분 포함)를 재비교하고, drift 면 같은
        // 트랜잭션을 통째로 롤백해 RE_REQUEST_REQUIRED 로 분류되게 한다.
        if (approvalContext) {
          this.assertApprovalSnapshotMatches(
            approvalContext,
            buildCreditExcessSnapshot({
              order,
              lifecycleMode: cutoverMode,
              billingUserId,
              walletAccountId: String(wallet.id),
              settleMethod: effectiveSettleMethod,
              cardSurchargeApplied: effectiveSurcharge,
              finalAmount,
              remainServiceAmount,
              excessAmount: finalAllocation.creditExcessAmount,
              payableSettlementAmount: finalAllocation.payableSettlementAmount,
              usage: getBody,
              allocation: {
                pointUsedAmount: finalAllocation.pointUsedAmount,
                depositUsedAmount: finalAllocation.depositUsedAmount,
                creditUsedAmount: finalAllocation.creditUsedAmount,
                creditExcessAmount: finalAllocation.creditExcessAmount,
                cardSurchargeAmount: finalAllocation.cardSurchargeAmount,
              },
            }),
          );
        }

        // 4'. legacy mirror (same TX, user.balance 제외)
        order.settleAmount = finalAllocation.payableSettlementAmount;
        order.isSettleBalance = finalAllocation.creditUsedAmount === 0 && finalAllocation.creditExcessAmount === 0;
        order.isCreditExcess = finalAllocation.creditExcessAmount > 0;

        if (isCompanyBalanceMode && oneUser.company) {
          oneUser.company.balance -= finalAllocation.depositUsedAmount;
        }
        oneUser.allSettleAmount += finalAllocation.creditUsedAmount + finalAllocation.creditExcessAmount;

        // 5'. 저장 — user.balance 는 *기록하지 않음* (wallet ledger 가 진실의 원천)
        await this.userRepository.update({ id: oneUser.id }, { allSettleAmount: oneUser.allSettleAmount });
        if (isCompanyBalanceMode && oneUser.company) {
          await this.userCompanyRepository.update({ id: oneUser.company.id }, { balance: oneUser.company.balance });
        }

        walletAllocation = finalAllocation;
      } else {
        // === LEGACY 또는 SHADOW: finalAmount 기준 신용초과 판정 유지 ===
        const legacyExcessAmount = Math.max(0, finalAmount - remainServiceAmount);

        if (approvalContext) {
          this.assertApprovalSnapshotMatches(
            approvalContext,
            buildCreditExcessSnapshot({
              order,
              lifecycleMode: cutoverMode,
              billingUserId,
              walletAccountId: null,
              settleMethod: effectiveSettleMethod,
              cardSurchargeApplied: effectiveSurcharge,
              finalAmount,
              remainServiceAmount,
              excessAmount: legacyExcessAmount,
              payableSettlementAmount: finalAmount,
              usage: getBody,
              allocation: null,
            }),
          );
        }

        if (legacyExcessAmount > 0) {
          if (!approvalContext) {
            // 사용자 호출: 신용초과 승인 요청 안내 응답 (SSG confirmEventBalance 미실행)
            return {
              message: 'credit_excess',
              creditExcess: true,
              excessAmount: legacyExcessAmount,
              remainServiceAmount,
              finalAmount,
            };
          }
          order.isCreditExcess = true;
          this.logger.warn(
            `신용초과 발송확정(승인 실행): orderId=${order.id}, approvalId=${approvalContext.approvalId}, 초과액=${legacyExcessAmount.toLocaleString()}원, 필요=${finalAmount.toLocaleString()}원, 가능=${remainServiceAmount.toLocaleString()}원`,
          );
        }

        // 3-1. SSG 가차감 확정 (진행 결정 통과 후에만 실행)
        if (order.type === IOrderType.SSG) {
          await this.ssgEventService.confirmEventBalance(order.id);
        }

        // 4. isSettleBalance 결정 + 차감
        if (finalAmount <= effectiveBalance) {
          if (isCompanyBalanceMode && oneUser.company) {
            oneUser.company.balance -= finalAmount;
          } else {
            oneUser.balance -= finalAmount;
          }
          order.isSettleBalance = true;
        } else {
          oneUser.allSettleAmount += finalAmount;
          order.isSettleBalance = false;
        }

        // 5. 저장 (atomic UPDATE: 특정 필드만 반영해 stale overwrite 방지)
        order.settleAmount = finalAmount;
        await this.userRepository.update(
          { id: oneUser.id },
          { balance: oneUser.balance, allSettleAmount: oneUser.allSettleAmount },
        );
        if (isCompanyBalanceMode && oneUser.company) {
          await this.userCompanyRepository.update({ id: oneUser.company.id }, { balance: oneUser.company.balance });
        }

        if (cutoverMode === WalletCutoverMode.SHADOW) {
          // wallet preview (pure compute, no DB write) + mismatch 비교 로그
          try {
            const wallet = await this.walletAccountResolverService.resolveForOrder(order, this.orderRepository.manager);
            const previewInput = await this.walletAllocationInputBuilder.build(order, wallet, finalAmount, {
              companyId: oneUser.companyId,
              cardSurchargeApplied: effectiveSurcharge,
            });
            const preview = this.paymentAllocationService.allocate(previewInput);

            // legacy 의 4재원 분해:
            //  - 예치금 = min(finalAmount, effectiveBalance)
            //  - overflow = max(0, finalAmount - effectiveBalance)
            //  - 그 중 한도 잔여 (maximumLimit - allSettleAmount) 까지는 credit_used (정상 후정산),
            //    나머지는 credit_excess (신용초과).
            //  legacy 가 전부 excess 로 찍히면 정상 credit 사용도 real_drift 분류 → 모니터링 신뢰도 ↓.
            const legacyDeposit = Math.min(finalAmount, effectiveBalance);
            const legacyOverflow = Math.max(0, finalAmount - effectiveBalance);
            const legacyLimitRemain = Math.max(0, (oneUser.company?.maximumLimit ?? 0) - oneUser.allSettleAmount);
            const legacyCreditUsed = Math.min(legacyOverflow, legacyLimitRemain);
            const legacyCreditExcess = legacyOverflow - legacyCreditUsed;
            const mismatch = this.shadowMismatchClassifierService.classify(
              {
                depositUsedAmount: preview.depositUsedAmount,
                creditUsedAmount: preview.creditUsedAmount,
                creditExcessAmount: preview.creditExcessAmount,
                pointUsedAmount: preview.pointUsedAmount,
                cardSurchargeAmount: preview.cardSurchargeAmount,
                payableSettlementAmount: preview.payableSettlementAmount,
              },
              {
                depositUsedAmount: legacyDeposit,
                creditUsedAmount: legacyCreditUsed,
                creditExcessAmount: legacyCreditExcess,
                pointUsedAmount: 0,
                cardSurchargeAmount: 0,
                payableSettlementAmount: finalAmount,
              },
            );
            if (mismatch) {
              this.logger.warn(
                `wallet_shadow_mismatch orderId=${order.id} class=${mismatch} preview=${JSON.stringify({
                  deposit: preview.depositUsedAmount,
                  credit: preview.creditUsedAmount,
                  excess: preview.creditExcessAmount,
                  payable: preview.payableSettlementAmount,
                })} legacy=${JSON.stringify({
                  deposit: legacyDeposit,
                  credit: legacyCreditUsed,
                  excess: legacyCreditExcess,
                  finalAmount,
                })}`,
              );
            }
          } catch (err) {
            // shadow 비교 실패는 legacy path 를 막지 않음
            this.logger.warn(
              `wallet_shadow_preview_failed orderId=${order.id} err=${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    } else {
      // === 기존 흐름: 차액 조정 ===
      const getEffectiveBalance = () =>
        isCompanyBalanceMode && oneUser.company ? oneUser.company.balance : oneUser.balance;
      const setEffectiveBalance = (value: number) => {
        if (isCompanyBalanceMode && oneUser.company) {
          oneUser.company.balance = value;
        } else {
          oneUser.balance = value;
        }
      };
      const addEffectiveBalance = (amount: number) => setEffectiveBalance(getEffectiveBalance() + amount);
      const subtractEffectiveBalance = (amount: number) => setEffectiveBalance(getEffectiveBalance() - amount);

      // 기존 흐름은 createTemp에서 sendAmount가 이미 차감된 상태이므로 최종 정산금액과 정가 차액만 반영하면 장부가 일치
      const netDelta = finalAmount - order.sendAmount;

      if (netDelta !== 0) {
        const deltaBreakdown = `최종정산=${finalAmount}, 발송정가=${order.sendAmount}`;

        if (netDelta < 0) {
          // 순 환급 (할인이 카드할증보다 큼)
          const refundAmount = Math.abs(netDelta);
          if (order.isSettleBalance) {
            addEffectiveBalance(refundAmount);
          } else {
            oneUser.allSettleAmount -= refundAmount;
          }
          this.logger.debug(
            `정산 차액 환급: orderId=${order.id}, 환급액=${refundAmount} (${deltaBreakdown}), isSettleBalance=${order.isSettleBalance}`,
          );
        } else {
          // 순 추가 차감 (할증 + 카드할증이 할인을 초과)
          const currentBalance = getEffectiveBalance();

          if (order.isSettleBalance) {
            if (currentBalance >= netDelta) {
              subtractEffectiveBalance(netDelta);
              this.logger.debug(
                `정산 차액 차감 (balance): orderId=${order.id}, 추가액=${netDelta} (${deltaBreakdown})`,
              );
            } else {
              const companyMaximumLimit = oneUser.company?.maximumLimit ?? 0;
              const remainingLimit = companyMaximumLimit - oneUser.allSettleAmount;
              const neededFromLimit = netDelta - currentBalance;

              if (remainingLimit >= neededFromLimit) {
                oneUser.allSettleAmount += neededFromLimit;
                setEffectiveBalance(0);
                message = 'warning: 잔여발송한도가 부족하여 한도에서 추가 차감되었습니다.';
                this.logger.debug(
                  `정산 차액 차감 (한도 추가): orderId=${order.id}, 추가액=${netDelta} (${deltaBreakdown}), 한도사용=${neededFromLimit}`,
                );
              } else {
                throw new BadRequestException(
                  `잔여발송한도가 부족하여 발송을 진행할 수 없습니다. (필요 금액: ${netDelta.toLocaleString()}원[할증/카드할증 포함], 사용 가능: ${(currentBalance + remainingLimit).toLocaleString()}원)`,
                );
              }
            }
          } else {
            const companyMaxLimit = oneUser.company?.maximumLimit ?? 0;
            const remainingLimit = companyMaxLimit - oneUser.allSettleAmount;

            if (remainingLimit >= netDelta) {
              oneUser.allSettleAmount += netDelta;
              message = 'warning: 정산 차액(할증/카드할증)이 추가되었습니다.';
              this.logger.debug(`정산 차액 차감 (한도): orderId=${order.id}, 추가액=${netDelta} (${deltaBreakdown})`);
            } else if (currentBalance >= netDelta - remainingLimit) {
              const neededFromBalance = netDelta - remainingLimit;
              oneUser.allSettleAmount = companyMaxLimit;
              subtractEffectiveBalance(neededFromBalance);
              message = 'warning: 한도가 부족하여 선충전 잔액에서 추가 차감되었습니다.';
              this.logger.debug(
                `정산 차액 차감 (선충전 추가): orderId=${order.id}, 추가액=${netDelta} (${deltaBreakdown}), 선충전사용=${neededFromBalance}`,
              );
            } else {
              throw new BadRequestException(
                `잔여발송한도가 부족하여 발송을 진행할 수 없습니다. (필요 금액: ${netDelta.toLocaleString()}원[할증/카드할증 포함], 사용 가능: ${(currentBalance + remainingLimit).toLocaleString()}원)`,
              );
            }
          }
        }

        await this.userRepository.update(
          { id: oneUser.id },
          { balance: oneUser.balance, allSettleAmount: oneUser.allSettleAmount },
        );
        if (isCompanyBalanceMode && oneUser.company) {
          await this.userCompanyRepository.update({ id: oneUser.company.id }, { balance: oneUser.company.balance });
        }
      }

      order.settleAmount = finalAmount;
    }
    // ======== 과금 처리 끝 ========
    if (!hasSettleInput) {
      order.settleMethod = effectiveSettleMethod;
      order.cardSurchargeApplied = effectiveSurcharge;
    }

    for (const orderMapping of order.orderProductMappings!) {
      for (const orderDelivery of orderMapping.orderDeliveries) {
        // PIN 발급은 배치에서 실제 발송 시점에 수행
        // 상태를 WAIT으로 변경 (ssgEventId는 이미 deliveryRequest에서 할당됨)
        orderDelivery.status = IOrderDeliveryStatus.WAIT;

        await this.orderDeliveryRepository.save(orderDelivery);
      }
    }

    order.status = IOrderStatus.DELIVERY_CONFIRMED;
    await this.orderRepository.save(order);
    if (approvalContext) {
      // 실행 표식 — 발송확정과 **같은 트랜잭션**에서 1회만 기록. 최종화·lease 복구의 공통 진실 원천.
      await this.creditExcessApprovalService.recordExecution(this.orderRepository.manager, {
        approvalId: approvalContext.approvalId,
        orderId: order.id,
        attemptToken: approvalContext.attemptToken,
        lifecycleMode: this.walletCutoverConfig.pr2DeliveryLifecycleMode,
      });
      await this.activityLogService.createLog({
        userId: approvalContext.approverUserId,
        userEmail: approvalContext.approverEmail,
        method: 'POST',
        requestUrl: `/credit-excess-approvals/${approvalContext.approvalId}/approve`,
        actionType: 'CREDIT_EXCESS_APPROVAL_DISPATCH',
        ipAddress: approvalContext.ipAddress,
        statusCode: 200,
        result: ActivityLogResult.SUCCESS,
        responseTime: 0,
        requestParams: {
          approvalId: approvalContext.approvalId,
          orderId: order.id,
          approverUserId: approvalContext.approverUserId,
          requesterUserId: approvalContext.requesterUserId,
          attemptToken: approvalContext.attemptToken,
          executedBy: 'SERVER_DISPATCH',
        },
      });
    }
    if (!hasSettleInput) {
      await this.logSettleDiscountChange({
        user,
        orderId: order.id,
        requestUrl: '/order/delivery-confirmed',
        method: 'POST',
        source: SettleDiscountChangeSource.AUTO_CONFIRM,
        changes: [],
        orderBefore: settleOrderBefore,
        orderAfter: {
          settleMethod: order.settleMethod,
          cardSurchargeApplied: order.cardSurchargeApplied,
          settleAmount: order.settleAmount,
        },
      });
    }

    return { message: message, ...this.allocationDetail(walletAllocation) };
  }

  @Transactional()
  async ssgCouponExpireChange(user: ILoginUserInfo, getBody: OrderDeliverySsgCouponExpireChangeReqDto) {
    const { id, couponExpiration } = getBody;

    const beforeOrder = await this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.product', 'product')
      .innerJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.id = :id', { id })
      // .andWhere('order.userId = :userId', { userId: user.id })
      .andWhere('order.status = :status', { status: IOrderStatus.DELIVERY_REQUEST })
      .andWhere('order.type = :type', { type: IOrderType.SSG })
      .setLock('pessimistic_write')
      .getOne();

    if (!beforeOrder) {
      throw new BadRequestException('해당 주문건은 존재하지 않습니다.');
    }

    const couponExpirationProduct = beforeOrder.orderProductMappings![0].product.expireDay;

    if (couponExpiration === couponExpirationProduct) {
      throw new BadRequestException(`유효기간이 ${couponExpiration}일 로 동일합니다.`);
    }

    const hasDeduction = await this.ssgEventService.hasOpenTempDeduction(beforeOrder.id);
    if (!hasDeduction) {
      throw new BadRequestException('처리 가능한 가차감 이력이 없습니다.');
    }

    const afterProductList = await this.productRepository.find({
      where: {
        type: IProductType.SSG,
        expireDay: couponExpiration,
      },
    });
    const afterProductPriceMap = listToMapValue(
      afterProductList,
      (product) => product.price,
      (product) => product.id,
    );

    // restore 대상(기존 이벤트)과 allocate 후보(새 유효기간 이벤트)를 id ASC 순서로 선잠금하여
    // 서로 다른 트랜잭션 간 락 순서 역전(데드락 소지)을 차단한다.
    await this.ssgEventService.lockEventsForCouponExpireChange(beforeOrder.id, couponExpiration);

    // 상품 교체 전: 기존 이벤트 가차감(isTemporary=true) 복원
    await this.ssgEventService.restoreTemporaryEventBalance(beforeOrder.id);

    for (const orderProductMapping of beforeOrder.orderProductMappings!) {
      const beforeProductId = orderProductMapping.productId;
      const afterProductId = afterProductPriceMap.get(orderProductMapping.product.price);
      if (!afterProductId) {
        throw new InternalServerErrorException('신세계 product 가 존재하지 않습니다.');
      }

      await this.orderProductMappingRepository.update(
        {
          orderId: beforeOrder.id,
          productId: beforeProductId,
        },
        {
          productId: afterProductId,
        },
      );
    }

    // 새 유효기간 이벤트 재할당 + 가차감 (배송건별 예약시각을 개별 반영 — 상품별 예약발송 정책 유지)
    const deliveries: { deliveryId: number; price: number; reserveDate?: Date }[] = [];
    for (const mapping of beforeOrder.orderProductMappings!) {
      const afterProductId = afterProductPriceMap.get(mapping.product.price);
      const afterProduct = afterProductList.find((p) => p.id === afterProductId);
      const price = afterProduct?.price ?? mapping.product.price;
      const reserveDate =
        mapping.sendType === 'RESERVE' && mapping.sendRequestAt
          ? new Date(mapping.sendRequestAt as unknown as string)
          : undefined;
      for (const delivery of mapping.orderDeliveries) {
        deliveries.push({ deliveryId: delivery.id, price, reserveDate });
      }
    }

    const allocations = await this.ssgEventService.allocateEventsForDeliveries(deliveries, couponExpiration);

    if (!allocations) {
      throw new BadRequestException('사용 가능한 SSG 이벤트가 없습니다. (잔액 부족)');
    }

    await this.ssgEventService.deductEventBalanceMultiple(allocations, beforeOrder.id, true);

    // orderDelivery.ssgEventId 및 order.ssgEventId 재저장
    const allocationMap = new Map<number, number>();
    for (const alloc of allocations) {
      allocationMap.set(alloc.deliveryId, alloc.eventId);
    }

    for (const mapping of beforeOrder.orderProductMappings!) {
      for (const delivery of mapping.orderDeliveries) {
        if (allocationMap.has(delivery.id)) {
          await this.orderDeliveryRepository.update(delivery.id, {
            ssgEventId: allocationMap.get(delivery.id),
          });
        }
      }
    }

    await this.orderRepository.update(beforeOrder.id, {
      ssgEventId: allocations[0]?.eventId ?? null,
    });
  }

  /**
   * 주문 안에서 지금 취소할 수 있는 발송건 id 목록.
   *
   * 아래 조건을 **모두** 만족해야 한다. 하나라도 빠지면 이미 고객에게 간 쿠폰을 취소하고
   * 돈까지 돌려주는 사고가 된다.
   *
   *  1) status = WAIT
   *     발송 대기 중인 행만. COMPLETE/FAIL/CANCEL 은 이미 끝난 건이다.
   *
   *  2) actual_send_at IS NULL
   *     ★ status 만으로 미발송을 판정하면 안 된다. 외부 API 발송 성공 처리
   *       (external.api.service.ts phaseC_handleSuccess)는 orderDelivery.actualSendAt 과
   *       order.status 만 세팅하고 orderDelivery.status 는 건드리지 않는다 — 즉 발송에
   *       성공해도 WAIT 로 남는다. 같은 이유로 외부 API 취소 가드도 status 가 아니라
   *       actualSendAt 을 본다. 이 조건이 없으면 이미 나간 쿠폰이 취소된다.
   *
   *  3) claimed_at IS NULL
   *     발송 배치가 이미 집어간(claim) 행은 곧 나간다. claimWaitDeliveries 가
   *     claimed_at 을 CAS 로 세팅해 소유권을 잡으므로, 잡힌 행은 건드리지 않는다.
   *
   *  4) send_request_at >= now + DELIVERY_CANCEL_CUTOFF_MS
   *     티켓의 "실발송 10분 전까지" 규칙. 배치는 send_request_at < now 인 행만 집으므로
   *     이 조건과 배치의 픽업 조건은 서로 겹치지 않는다.
   *
   *  5) coupon_issued_at IS NULL  /  6) bar_code IS NULL
   *     쿠폰이 이미 발급된 행은 취소 대상이 아니다. 발급 후 발송 직전에 프로세스가 죽으면
   *     그 행은 status=WAIT / actual_send_at=NULL 로 남고, 재기동 시 releaseStaleBatchClaims 가
   *     claimed_at 까지 NULL 로 되돌린다 — 조건 1·2·3 을 모두 통과하는 상태가 된다.
   *     현재는 그런 행의 send_request_at 이 과거라 조건 4 가 막아주지만, 그건 claimed_at 이
   *     막는 것이 아니라 컷오프에 우연히 걸리는 것이다. 발급 여부를 직접 본다.
   *
   *     ★ 두 컬럼을 모두 봐야 한다. coupon_issued_at 은 초이스 선택 / 이메일 수령 경로에서만
   *       기록된다(order.receive.service.ts). 일반 배치 발송의 PIN 발급은 이 컬럼을 건드리지
   *       않고 bar_code 만 채우며, 배치 자신도 "이미 발급됐나" 를 bar_code 로 판정한다
   *       (delivery.batch.service.ts). 즉 coupon_issued_at 만 보면 배치 경로에서는 방어력이 0 이다.
   *       bar_code 는 실제 쿠폰 발급 시점(배치 발송)에만 채워지므로, 이 조건이 정상적인 예약
   *       대기 건의 취소를 막지는 않는다.
   *       (테스트발송은 여기 해당하지 않는다 — testDelivery 는 test_order_delivery 에만 쓰고
   *        order_delivery 행은 건드리지 않는다. 테스트발송했다고 취소가 막히지 않는다.)
   *
   *  7) order.type != EXTERNAL
   *     외부 API 주문은 배치가 claim 하지 않으므로(claimWaitDeliveries 의 EXISTS 조건)
   *     claimed_at 이 영원히 NULL 이고, 그 경로에서 조건 3 은 방어력이 0 이다.
   *     지금 안전한 이유는 외부 API 가 sendRequestAt 을 즉시(now)로만 만들어 조건 4 에
   *     걸리기 때문인데, 그것은 타 모듈의 암묵 불변식이다. 외부 API 에 예약발송이 생기면
   *     조건 3·4 가 동시에 무너진다. 배치가 EXTERNAL 을 명시 배제하는 것과 대칭을 맞춘다.
   *
   * ※ 이 헬퍼는 **부분취소 경로(partialDeliveryCancel)에서만** 쓴다.
   *   전체취소 경로는 여전히 주문 단위로 판정한다 — 예약 mapping 들의 sendRequestAt 중 가장
   *   이른 값 하나로 주문 전체를 보는 reserveSendTimes 블록(같은 파일 deliveryCancel 안).
   *   그 방식은 "주문 전체를 한꺼번에 취소한다" 는 전제에서는 옳고, 전체취소는 앞단의
   *   countIrreversibleDeliveries 가 이미 나간 건이 섞인 주문을 통째로 거부하므로 유지한다.
   *   취소 단위가 발송건으로 내려가는 부분취소에서만 이 헬퍼가 필요하다.
   *
   * soft-delete 된 행은 SelectQueryBuilder 가 deleted_at 필터를 자동 적용해 제외된다
   * (UpdateQueryBuilder 는 자동 적용하지 않으므로 갱신 시에는 명시해야 한다).
   */
  // ★ 아래 조건집합은 domain/delivery.cancelable.ts 의 evaluateDeliveryCancelable(화면 표시용)과
  //   1:1 로 일치해야 한다. 이 SQL 이 권위값(취소는 이 결과의 부분집합만 허용)이고 술어는 advisory 다.
  //   조건을 바꾸면 양쪽을 함께 바꾸고 delivery.cancelable.spec.ts 로 어긋남을 잡는다.
  private async findCancelableDeliveryIds(orderId: number, now: Date): Promise<number[]> {
    const cutoff = new Date(now.getTime() + DELIVERY_CANCEL_CUTOFF_MS);

    const rows = await this.orderDeliveryRepository
      .createQueryBuilder('od')
      .select('od.id', 'id')
      .innerJoin('od.orderProductMapping', 'opm')
      .innerJoin('opm.order', 'o')
      .where('opm.orderId = :orderId', { orderId })
      .andWhere('od.status = :wait', { wait: IOrderDeliveryStatus.WAIT })
      .andWhere('od.actualSendAt IS NULL')
      .andWhere('od.claimedAt IS NULL')
      .andWhere('od.sendRequestAt >= :cutoff', { cutoff })
      .andWhere('od.couponIssuedAt IS NULL')
      .andWhere('od.barCode IS NULL')
      // 발송 배치(claimWaitDeliveries)가 집는 조건집합과 맞춘다. 지금은 bar_code IS NULL 이
      // 간접적으로 같은 행을 걸러내지만, 그건 "발급되면 bar_code 도 찬다" 는 다른 모듈의
      // 암묵 불변식에 기댄 것이다. 배치가 직접 보는 컬럼을 여기서도 본다(조건 6 과 같은 이유).
      .andWhere('od.reportState IS NULL')
      // CAS 와 같은 조건집합을 유지한다 — 여기만 빠지면 화면엔 취소가능으로 뜨고 누르면 실패한다.
      // (두 곳의 drift 는 cancelable parity 실DB 테스트가 감지한다)
      .andWhere('od.couponStatus NOT IN (:...unsendable)', { unsendable: UNSENDABLE_COUPON_STATUSES })
      .andWhere('(od.mutationClaimedAt IS NULL OR od.mutationClaimedAt < :mutationStale)', {
        mutationStale: new Date(now.getTime() - MUTATION_CLAIM_STALE_MS),
      })
      .andWhere('o.type != :externalType', { externalType: IOrderType.EXTERNAL })
      .orderBy('od.id', 'ASC')
      .getRawMany<{ id: number }>();

    return rows.map((row) => Number(row.id));
  }

  /**
   * 고른 발송건을 CANCEL 로 전환한다. 조건부 UPDATE(CAS) 이며 갱신된 행 수를 돌려준다.
   *
   * findCancelableDeliveryIds 로 목록을 고른 시점과 실제로 바꾸는 시점 사이에는 시간이 흐른다.
   * 그 사이 발송 배치가 같은 행을 claim 해 갈 수 있으므로, 판정 조건을 UPDATE 의 WHERE 에
   * 다시 넣어 DB 가 갱신 순간에 확인하게 한다. 조건이 어긋난 행은 갱신되지 않고 affected 로 드러난다.
   *
   * 하나라도 못 바꾸면 여기서 던진다. 반환값으로 알리고 호출자가 검사하게 두지 않는다 —
   * TypeScript 에는 반환값 무시를 막는 수단이 없어(`await fn(...)` 이 경고 없이 통과)
   * "반드시 확인하라" 는 계약이 주석 외에 강제력을 갖지 못한다. 판정에 필요한 값
   * (요청 건수·affected)을 이 함수가 이미 다 쥐고 있으므로 판정도 여기서 한다.
   * @Transactional() 이라 throw 가 곧 롤백이고, 어차피 롤백이 유일한 정답이라
   * 호출부에 선택권을 줄 이유가 없다.
   *
   * 중복 id 는 들여보내지 않는다. SQL 의 IN 은 집합이라 중복을 접으므로
   * [9003, 9003, 9004] 는 affected 2 가 되어 정상 취소가 "경합" 으로 오판된다.
   * DTO 의 @ArrayUnique 가 정상 경로를 막지만, 서비스를 직접 부르는 경로가 생겨도
   * 뚫리지 않도록 여기서도 접는다.
   *
   * ★ deleted_at IS NULL 을 명시한 이유: UpdateQueryBuilder 는 SelectQueryBuilder 와 달리
   *   soft-delete 필터를 자동으로 붙이지 않는다. 없으면 soft-delete 된 행까지 취소된다.
   *   근거: typeorm 0.3.28 QueryBuilder.createWhereExpression 이 deleted_at IS NULL 을
   *   queryType === 'select' 인 경우에만 삽입한다. 업그레이드 시 이 지점을 재확인할 것.
   *
   * ★ orderId 스코프가 반드시 필요하다. deliveryIds 는 결국 요청 바디에서 온 값이고,
   *   id IN (...) 만으로는 이 함수가 그 값을 무조건 신뢰하게 된다. 남의 주문 발송건 id 를
   *   섞어 보내면 그 건이 취소되고 환불은 요청자의 주문 기준으로 일어난다 — IDOR 이면서
   *   자금 결함이다. deliveryCancel 은 소유권 검사가 주석 처리돼 있고 엔드포인트 가드도
   *   클래스 레벨 인증뿐이라 앞단에서 걸러진다는 보장이 없다.
   *   호출부에서 findCancelableDeliveryIds 결과와 교집합을 취하더라도 여기서 한 번 더 막는다.
   *   이 함수가 "돈을 되돌려도 되는가" 판정의 마지막 관문이고, 조건 추가 비용은 사실상 0이다.
   *   (배치의 claimWaitDeliveries 도 같은 EXISTS 패턴으로 주문 타입을 제한한다.)
   *
   * ★ 조회 단계(findCancelableDeliveryIds)의 조건집합을 **그대로 재검증**한다 — status/claimed_at/
   *   actual_send_at 에 더해 coupon_issued_at·bar_code·report_state·EXTERNAL 까지(관리자 리뷰 HIGH).
   *   조회~갱신 사이에 쿠폰이 발급되면 status 는 WAIT, claimed_at 은 NULL 인 채로 발급 신호만 생길
   *   수 있고, 그 조합은 종전 4개 조건으로는 걸러지지 않아 **발급된 쿠폰을 취소하고 환불**하게 된다.
   *   지금은 발송 경로들이 claimed_at/actual_send_at 을 먼저 채워 간접 차단되지만 그것은 타 모듈의
   *   암묵 불변식이다. 이 문장이 "돈을 되돌려도 되는가" 의 마지막 관문이므로 남에게 기대지 않는다.
   *
   * sendRequestAt(10분 규칙)도 **갱신 직전에 새로 읽은 시각** 기준으로 다시 본다(조회 때 쓴 now 를
   * 재사용하면 재검증이 아니다). 조회~갱신 사이에 send_request_at 이 다른 흐름(유효기간 변경·재발행)
   * 으로 앞당겨진 행을 배제하고, "발송 10분 전까지" 규칙을 갱신 시점에도 지킨다.
   * SQL NOW() 를 쓰지 않는 이유는 DB 서버 time_zone 설정에 의존하게 되어(저장은 드라이버
   * timezone 변환) 설정이 바뀌면 조건이 조용히 무력화되기 때문이다 — 자세한 근거는 아래 주석 참조.
   * (미발송 자체는 위 상태 신호들이 보장한다 — 배치는 send_request_at 이 지난 행만 집고 집는 순간
   * claimed_at 이 차므로, 이 조건은 규칙 준수용이지 유일한 근거가 아니다.)
   */
  private async cancelDeliveriesIfStillWaiting(
    orderId: number,
    deliveryIds: number[],
    cancelReason: string,
    canceledAt: Date,
  ): Promise<void> {
    const targetIds = [...new Set(deliveryIds)];

    if (targetIds.length === 0) {
      // 여기 도달하는 빈 목록은 호출자 버그다. DTO(@ArrayNotEmpty)와 선별 단계가 이미 걸렀어야 한다.
      // 조용히 0 을 돌려주면 "요청 0건 = affected 0건" 이 되어 "전부 성공" 으로 판정되고,
      // 발송건은 하나도 취소되지 않은 채 환불만 실행된다.
      throw new InternalServerErrorException(
        `cancelDeliveriesIfStillWaiting: 취소 대상이 비어 있다 (orderId=${orderId})`,
      );
    }

    // ★ 컷오프 재검증 기준 시각은 **갱신 직전에 새로 읽는다**(조회 때 쓴 now 를 재사용하면 재검증이
    //   아니다). NOW() 같은 SQL 함수를 쓰지 않는 이유는 타임존 의존을 만들지 않기 위해서다 —
    //   NOW() 는 DB 서버 time_zone 설정을 따르는데 send_request_at 은 드라이버가 커넥션
    //   timezone('+09:00')으로 변환해 넣은 값이라, 서버 tz 가 UTC 로 바뀌면 9시간이 어긋나
    //   조건이 **항상 참(= 조용한 무력화)** 이 된다. 자금 가드가 인프라 설정 변경에 조용히
    //   꺼지면 안 된다. JS Date 를 바인딩하면 저장할 때와 같은 변환을 거쳐 항상 정합적이다.
    //   (dev RDS·로컬 모두 Asia/Seoul 이라 지금은 NOW() 로도 맞지만, 그 일치에 기대지 않는다.)
    const cutoffAt = new Date(Date.now() + DELIVERY_CANCEL_CUTOFF_MS);

    const result = await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({
        status: IOrderDeliveryStatus.CANCEL,
        // ★ 변형 lease 를 취소 소유로 **탈취**한다 (197-16 리뷰 P1).
        //   아래 WHERE 는 stale(5분 초과) lease 를 통과시킨다 — 크래시 잔재가 발송건을 영구히
        //   취소 불가로 만들지 않기 위해서다. 그런데 통과만 시키고 값을 그대로 두면, 아직 살아 있는
        //   원 소유자(외부 통신이 길어진 CS 폐기·재발행)의 후속 쓰기가 `WHERE mutation_claimed_at =
        //   자기토큰` 으로 여전히 일치해 affected=1 로 성공한다. 그 쓰기는 status 를 다시 쓰므로
        //   (delivery.batch.service.ts:1965 updateDeliveryOwned) 방금 CANCEL 로 바꾼 행이
        //   COMPLETE 로 되살아나고, 우리는 이미 환불까지 끝낸 뒤다.
        //   탈취하면 그 쓰기가 affected=0 이 되어 [BATCH_FENCE_LOST] 로 시끄럽게 멈춘다.
        //   같은 규칙이 배치 선점에 이미 명시돼 있다 — delivery.batch.service.ts:696 주석 참조.
        //   ※ 값은 canceledAt 과 같게 둔다(형제와 동일 관례 — 소유자 식별이 일관된다).
        //   ※ 해제하지 않는다: 토큰 값이 canceledAt(= 그때의 now)이라 MUTATION_CLAIM_STALE_MS
        //     뒤에는 stale 로 판정돼 **스스로 풀린다.** 그 사이 다른 변형 경로는 이 행에 대해
        //     affected=0 을 받는데, CANCEL 은 종단 상태라 어차피 거부돼야 할 쓰기들이다.
        //     ※ 처음에는 "모든 획득 경로가 status=WAIT 를 요구한다" 고 적어 뒀는데 **사실이 아니다**
        //       (197-16 재리뷰 F5). CS 폐기(customer.service.service.ts:1340)·리포트 lease
        //       (delivery.batch.service.ts:1243)·재발송(message-resend-executor.service.ts:351)
        //       은 status 를 안 본다. 안 풀어도 되는 근거는 WAIT 조건이 아니라 위의 자동 만료다.
        mutationClaimedAt: canceledAt,
        cancelReason,
        canceledAt,
      })
      .where('id IN (:...deliveryIds)', { deliveryIds: targetIds })
      // ★ EXTERNAL 배제까지 EXISTS 안에서 처리한다. 조회 단계(findCancelableDeliveryIds)의
      //   o.type != EXTERNAL 과 같은 조건 — order.type 은 불변이고 주문 행도 이미 잠겨 있어
      //   현실적으로 창이 없지만, "다른 단계가 걸러 줬을 것" 이라는 가정을 이 문장에 남기지 않는다.
      .andWhere(
        'EXISTS (SELECT 1 FROM order_product_mapping opm JOIN `order` o ON o.id = opm.order_id ' +
          'WHERE opm.id = order_delivery.order_product_mapping_id AND opm.order_id = :orderId ' +
          'AND o.type != :externalType)',
        { orderId, externalType: IOrderType.EXTERNAL },
      )
      .andWhere('status = :wait', { wait: IOrderDeliveryStatus.WAIT })
      .andWhere('claimedAt IS NULL')
      .andWhere('actualSendAt IS NULL')
      // ★ 발급/진행 신호를 CAS 에서도 재검증한다 (관리자 리뷰 HIGH).
      //   조회 단계는 이 셋을 보는데 갱신 단계가 빼면, 조회~갱신 창에서 쿠폰이 발급돼도
      //   status 가 WAIT 이고 claimed_at 이 비어 있는 경로로 취소·환불이 통과할 수 있다.
      //   현재는 발송 경로들이 claimed_at/actual_send_at 을 먼저 채워 간접 차단되지만, 그건
      //   타 모듈의 암묵 불변식이다. CAS 는 "돈을 되돌려도 되는가" 의 마지막 관문이므로
      //   조회 단계와 같은 조건집합을 직접 들고 있어야 한다(추가 비용 사실상 0).
      //   ※ sendRequestAt 컷오프만 제외 — 시간은 되돌아가지 않아 조회 시 통과했으면 갱신 시에도
      //     통과하고(여유만 줄어듦), 그 구간의 실질 방어는 claimed_at 이 담당한다.
      .andWhere('couponIssuedAt IS NULL')
      .andWhere('barCode IS NULL')
      .andWhere('reportState IS NULL')
      // ★ 쿠폰상태 축을 함께 본다 (리뷰 P1). status 와 coupon_status 는 **별개 축**이다 —
      //   CS 폐기(execDiscard)는 coupon_status 만 CANCEL/REFUND_CANCEL 로 쓰고 status 는 건드리지
      //   않으므로 `status=WAIT + coupon_status=CANCEL` 행이 실제로 존재한다
      //   (order.delivery.mutation.claim.ts 의 UNSENDABLE_COUPON_STATUSES 설명 참조).
      //   status 만 보는 이 CAS 는 그 "이미 폐기·환불된 핀" 을 취소 대상으로 잡아 한 번 더 환불했다.
      .andWhere('couponStatus NOT IN (:...unsendable)', { unsendable: UNSENDABLE_COUPON_STATUSES })
      // ★ CS 가 **지금 작업 중**인 건도 배제한다. 위 조건은 이미 커밋된 결과만 걸러낸다 —
      //   폐기가 협력사 통신 중이라 아직 커밋 전이면 coupon_status 는 그대로 NOT_USED 라
      //   어떤 격리수준으로도 보이지 않는다. 그 구간의 표시가 mutation_claimed_at lease 다.
      //   ※ IS NULL 로만 막으면 안 된다. 크래시로 해제 못 한 lease 는 스스로 지워지지 않아
      //     그 발송건이 **영구히** 취소 불가가 된다. CS 의 획득 조건과 같은 stale 규칙을 써서
      //     5분이 지난 lease 는 무시한다(self-heal 동일 기준).
      .andWhere('(mutationClaimedAt IS NULL OR mutationClaimedAt < :mutationStale)', {
        mutationStale: new Date(Date.now() - MUTATION_CLAIM_STALE_MS),
      })
      // ★ 컷오프를 갱신 시점 기준으로 다시 본다 (관리자 리뷰 P1). cutoffAt 은 이 UPDATE 직전에
      //   새로 읽은 시각이라, 조회~갱신 사이에 send_request_at 이 다른 흐름(유효기간 변경·재발행)
      //   으로 앞당겨져 발송이 임박해진 행을 배제한다.
      //   ※ 이 조건이 없어도 "이미 나간 건" 은 위 4개 신호가 막는다(배치는 send_request_at 이
      //     지난 행만 집고, 집는 순간 claimed_at 이 찬다). 즉 이 조건은 10분 규칙을 갱신 시점에도
      //     지키기 위한 것이지 미발송 보장의 유일한 근거가 아니다.
      .andWhere('sendRequestAt >= :cutoffAt', { cutoffAt })
      // ★ 컷오버 배제 술어 (§9 quiesce 계약 — legacy.delivery.entry.point.ts).
      //   이 UPDATE 는 legacy claim CAS 다(WAIT 을 선점해 CANCEL 로 바꾸고 그 근거로 환불한다).
      //   전환(cutover_migrated_at)·드레이닝(cutover_draining_at) 마크가 선 발송건은 Level A 슬롯
      //   모델이 소유하는데, 두 모델은 서로의 점유를 모른다. 이 술어가 없으면 신규 모델이 잡고 있는
      //   건을 legacy 취소가 함께 잡아 **중복 환불**이 뚫린다 — 계약이 막으려는 바로 그 경우다.
      //   가드(assertLegacyAllowed)가 아니라 술어로 다는 이유: 판정과 점유를 한 문장으로 원자화해야
      //   admission race(가드 통과 후 마크가 서는 창)가 닫힌다. 안전성의 근거는 술어 쪽이다.
      //   ※ 표시용 술어(evaluateDeliveryCancelable)에는 넣지 않는다 — 화면은 delivery_workflow 를
      //     읽지 않고, 컷오버는 운영 구간 상태라 여기서 걸리면 다른 경합과 똑같이 affected 부족 →
      //     ConflictException("다시 조회 후 재시도")으로 드러난다.
      .andWhere(NOT_CUTOVER_ORDER_DELIVERY)
      .andWhere('deletedAt IS NULL')
      // ※ 형제(delivery.batch.service.ts claimWaitDeliveries)에 있는 조건 중 **여기 없는 것이 하나**
      //   있다: 활성 pin_issue_command 배제(`NOT EXISTS … STARTED/RETRYING/…`). 의도적으로 뺐다.
      //   그 행은 ssg-insert-state.service.ts 에서만 만들어지는 SSG 전용이고, 부분취소는 진입부에서
      //   SSG 주문을 400 으로 거부하므로 지금은 도달 경로가 없다.
      //   ⚠️ SSG 부분취소를 여는 후속 티켓(docs/followup-ssg-partial-cancel.md)에서는 **반드시 넣어야**
      //     한다 — 발급 명령이 진행 중인 발송건을 취소하면 그 명령이 나중에 PIN 을 발급해
      //     "환불된 죽은 핀" 이 고객에게 간다.
      .execute();

    const affected = result.affected ?? 0;
    if (affected !== targetIds.length) {
      // 조회와 갱신 사이에 발송 배치가 claim 해 갔거나, 다른 경로가 상태를 바꿨다.
      // 로그에 요청/실제 건수와 id 를 남긴다 — 이게 없으면 "왜 취소가 안 됐나" 를 사후에 못 푼다.
      this.logger.error(
        `[DELIVERY_CANCEL_RACE] orderId=${orderId} requested=${targetIds.length} affected=${affected} ` +
          `ids=[${targetIds.join(',')}] — 발송 진행으로 상태가 바뀐 것으로 보임, 취소 롤백`,
      );
      throw new ConflictException(
        '취소 처리 중 일부 발송건이 발송 단계로 넘어가 취소하지 못했습니다. ' +
          '아무것도 취소되지 않았고 환불도 일어나지 않았습니다. ' +
          '발송 결과를 확인한 뒤 남은 대기 건만 다시 취소해 주세요.',
      );
    }
  }

  /**
   * 주문 안에서 이미 발송 단계로 넘어간 발송건 수.
   *
   * 전체취소가 그런 건까지 CANCEL 로 덮고 환불하는 것을 막기 위한 카운트다.
   * "취소 가능한가"(findCancelableDeliveryIds)의 여집합이 아니라 **되돌릴 수 없는 것만** 센다 —
   * 컷오프(10분)에 걸린 건은 아직 안 나갔으므로 여기 포함하지 않는다.
   *
   * 하나라도 해당하면 되돌릴 수 없다.
   *  - actual_send_at IS NOT NULL : 실제로 나갔다
   *  - coupon_issued_at IS NOT NULL : 쿠폰이 발급됐다(초이스 선택/이메일 수령 경로)
   *  - bar_code IS NOT NULL : PIN 이 협력사에 발급됐다(일반 배치 발송 경로 — 이쪽은
   *      coupon_issued_at 을 쓰지 않으므로 그 조건만으로는 잡히지 않는다)
   *  - claimed_at IS NOT NULL : 발송 배치가 이미 소유권을 잡았다. 곧 나가므로 덮으면 안 된다.
   *      부분취소는 이 창을 findCancelableDeliveryIds 조건 3 으로 명시적으로 막는데,
   *      전체취소만 빠져 있어 배치가 집어간 행을 CANCEL 로 덮을 수 있었다(같은 근거, 같은 방어).
   *  - status 가 터미널 : COMPLETE / COMPLETE_SMS / FAIL / FAIL_SMS
   */
  private async countIrreversibleDeliveries(orderId: number): Promise<number> {
    return this.orderDeliveryRepository
      .createQueryBuilder('od')
      .innerJoin('od.orderProductMapping', 'opm')
      .where('opm.orderId = :orderId', { orderId })
      .andWhere(irreversibleDeliveryPredicate('od.'), IRREVERSIBLE_TERMINAL_PARAMS)
      .getCount();
  }

  /**
   * 아직 취소되지 않은 발송건이 남아 있는 상품행(order_product_mapping) id 집합.
   *
   * 전체취소의 10분 컷오프는 예약 상품행들의 sendRequestAt 중 **가장 이른 시각**을 기준으로 판정한다.
   * 그런데 부분취소가 생기면서 "예약시각은 지났는데 발송은 안 된(=취소된) 상품행" 이 처음 생겼다.
   * 그 행을 그대로 최솟값 계산에 넣으면 지난 시각이 영구히 남아, 아직 여유가 충분한 나머지 예약건까지
   * 전체취소가 **영원히 400** 이 된다(시간이 갈수록 더 과거가 되므로 회복 경로가 없다).
   *
   *   예) A 12시 · B 15시 → 11시에 A 만 부분취소 → 13시에 B 전체취소 시도
   *       최솟값이 여전히 12시라 diff 가 음수 → "10분 전까지만 가능합니다" 로 거부
   *
   * 그래서 컷오프는 "아직 살아 있는 상품행" 만 봐야 한다. 취소된 행은 이미 환불까지 끝나 보호할
   * 대상이 아니다.
   *
   * ※ 발송건을 그래프로 끌어와 메모리에서 거르지 않는 이유: 여기서 필요한 것은 행별 "남아 있나"
   *   여부 하나뿐이라, 발송건이 수백~수천인 주문에서 전량 로딩은 낭비다. countIrreversibleDeliveries
   *   와 같은 전용 집계 쿼리 패턴을 따른다.
   */
  private async findMappingIdsWithActiveDeliveries(orderId: number): Promise<Set<number>> {
    const rows = await this.orderDeliveryRepository
      .createQueryBuilder('od')
      .innerJoin('od.orderProductMapping', 'opm')
      .select('DISTINCT opm.id', 'mappingId')
      .where('opm.orderId = :orderId', { orderId })
      .andWhere('od.status != :canceled', { canceled: IOrderDeliveryStatus.CANCEL })
      .andWhere('od.deletedAt IS NULL')
      .getRawMany<{ mappingId: number }>();

    return new Set(rows.map((row) => Number(row.mappingId)));
  }

  /**
   * 예약 발송건 부분취소 (197-16).
   *
   * deliveryIds 를 준 요청만 이 경로로 온다. 주지 않으면 종전대로 주문 전체가 취소된다 —
   * 발송확정 전에는 발송건이 전부 TEMP 라 "일부만 취소" 라는 개념도, 되돌릴 잔액도 없기 때문에
   * 부분취소를 강제하지 않는다.
   *
   * 전체취소와 다른 점:
   *  - 취소 대상을 요청이 지목한다(단, 반드시 findCancelableDeliveryIds 의 부분집합이어야 한다)
   *  - 환불이 주문 전액이 아니라 그 발송건 몫이다 (RefundPoolService.refund)
   *  - 잔여 발송건이 남으면 order.status 를 DELIVERY_CANCEL 로 내리지 않는다
   *
   * ※ 아래 @Transactional() 은 **독립 트랜잭션이 아니다.** 호출부(deliveryCancel)도 @Transactional()
   *   이고 둘 다 기본 전파(REQUIRED)라, 이 데코레이터는 새 트랜잭션도 세이브포인트도 만들지 않고
   *   호출부의 트랜잭션에 그대로 합류한다. 이 경로가 곳곳에서 기대는 "throw = 롤백" 은 이 데코레이터가
   *   보장하는 것이 아니라 **바깥 트랜잭션이 함께 롤백되기 때문에** 성립한다.
   *   그래서 호출부가 나중에 이 호출을 try/catch 로 감싸면 취소(CANCEL)와 환불 원장이 그대로 커밋된다 —
   *   "409 = 아무것도 안 됐다" 보장이 조용히 깨지므로 감싸지 말 것. 격리가 필요하면 전파를
   *   REQUIRES_NEW 로 올리는 것이 아니라(원장이 바깥과 갈라진다) 호출 구조를 바꿔야 한다.
   */
  @Transactional()
  private async partialDeliveryCancel(
    orderId: number,
    deliveryIds: number[],
    cancelReason: string,
  ): Promise<OrderPartialDeliveryCancelResDto> {
    // 전체취소와 동일하게 order 행부터 잠근다(락 순서 일관).
    const lockedOrder = await this.orderRepository
      .createQueryBuilder('order')
      .setLock('pessimistic_write')
      .where('order.id = :id', { id: orderId })
      .getOne();
    if (!lockedOrder) {
      throw new BadRequestException('해당 주문건은 존재하지 않습니다.');
    }

    // ★ 락을 잡은 뒤에 현재 시각을 읽는다. 락 대기는 innodb_lock_wait_timeout(기본 50초)까지
    //   늘어질 수 있어, 대기 전에 찍은 시각으로 10분 컷오프를 계산하면 그만큼 창이 헐거워지고
    //   canceled_at 도 과거로 기록된다.
    const now = new Date();

    // 부분취소는 발송확정 이후에만 성립한다. 그 전에는 발송건이 TEMP 라 막을 발송도, 되돌릴 돈도 없다.
    if (lockedOrder.status !== IOrderStatus.DELIVERY_CONFIRMED) {
      throw new BadRequestException(
        '발송 대기 상태의 주문만 발송건별로 취소할 수 있습니다. ' + 'deliveryIds 없이 요청하면 주문 전체가 취소됩니다.',
      );
    }

    // SSG 는 행사잔액 차감 이력이 주문 단위로 뭉쳐 있어(ssg_event_amount_history.order_delivery_id 미기록)
    // 발송건 몫을 역산할 근거가 없다. 근거 없이 안분하면 행사잔액이 부풀고, 그쪽은 상한 검증이 없어
    // 되돌리기 어렵다. 이 차단은 ssg_event_amount_history.order_delivery_id 에 귀속이 기록되고
    // restoreEventBalance 가 범위 복구를 지원한 뒤에야 풀 수 있다.
    // 후속 티켓으로 분리(2026-07-23 결정): docs/followup-ssg-partial-cancel.md 참조.
    // (SSG 는 지갑+행사잔액을 둘 다 차감하므로 부분취소도 두 축 복구가 필요 — 문서에 설계 스케치 포함.)
    if (lockedOrder.type === IOrderType.SSG) {
      throw new BadRequestException(
        'SSG 주문은 아직 발송건별 취소를 지원하지 않습니다. 주문 전체 취소를 이용해 주세요.',
      );
    }

    // 지갑(allocation) 이 없는 주문은 발송건 몫 환불의 근거가 없다.
    // 지갑 도입(2026-05) 이전 주문이 여기 해당하며, 취소 가능한 주문은 사실상 그 이후 것이다.
    const externalManager = this.orderRepository.manager;
    if (!(await this.walletManagedPredicate.isWalletManaged(orderId, externalManager))) {
      throw new BadRequestException(
        '이 주문은 발송건별 취소를 지원하지 않습니다(정산 정보 없음). 주문 전체 취소를 이용해 주세요.',
      );
    }

    // 요청한 id 가 "지금 취소 가능한 것" 의 부분집합인지 확인한다.
    // 부분 수용(가능한 것만 취소)하지 않는 이유: 요청자는 N건을 취소했다고 믿는데 실제로는 M건만
    // 취소되고 환불도 M건분이라, 차이를 응답으로 알려줘도 이미 일부가 커밋된 뒤다. 전량 거부가 안전하다.
    const cancelable = new Set(await this.findCancelableDeliveryIds(orderId, now));
    // 정렬해 둔다 — 멱등키·로그·에러 메시지가 요청 순서에 흔들리지 않게 한다.
    const requested = [...new Set(deliveryIds)].sort((a, b) => a - b);
    const notCancelable = requested.filter((deliveryId) => !cancelable.has(deliveryId));

    if (notCancelable.length > 0) {
      // 돈이 오가는 요청의 거부인데 서버에 흔적이 전혀 없었다. 사유를 알 수 없더라도
      // "어떤 주문의 어떤 id 가 걸렸는지" 는 남겨야 문의가 왔을 때 추적이 된다.
      this.logger.warn(
        `[DELIVERY_CANCEL_REJECT] orderId=${orderId} requested=[${requested.join(',')}] ` +
          `notCancelable=[${notCancelable.join(',')}] cancelable=[${[...cancelable].join(',')}]`,
      );
      // 응답에 나열하는 id 는 앞에서 자른다 — deliveryIds 상한이 1000 이라 전량을 이어붙이면
      // 에러 메시지 하나가 7KB 를 넘고, 화면에는 어차피 다 못 띄운다. 전량은 위 로그에 남는다.
      const shown = notCancelable.slice(0, NOT_CANCELABLE_IDS_IN_MESSAGE);
      const omitted = notCancelable.length - shown.length;
      throw new BadRequestException(
        `취소할 수 없는 발송건이 포함돼 있습니다: ${shown.join(', ')}` +
          (omitted > 0 ? ` 외 ${omitted}건` : '') +
          '. 이미 발송됐거나 발송 준비가 시작됐거나, 발송이 임박(10분 이내)했거나, ' +
          '이 주문의 발송건이 아니거나, 외부 API 주문일 수 있습니다. ' +
          '최신 발송 상태를 다시 조회해 주세요.',
      );
    }

    // 조건부 UPDATE. 갱신 건수가 요청과 다르면 그 사이 발송 단계로 넘어간 것이므로 여기서 던진다(롤백).
    await this.cancelDeliveriesIfStillWaiting(orderId, requested, cancelReason, now);

    // 취소분 몫만 환불한다. 재원 배분(신용초과 → 여신 → 예치금)과 멱등은 RefundPoolService 가 담당한다.
    //
    // ※ externalManager 를 넘겨 같은 트랜잭션에서 실행한다(외부 API 취소 / CS 폐기와 동일한 방식).
    //   refund-pool 의 lock 후 재조회가 평문 SELECT 라 호출자 격리수준을 따르는 기존 조건이 여기에도
    //   적용된다. 이번 브랜치가 새로 만든 문제가 아니라 기존 호출부 4곳 중 3곳이 이미 같은
    //   조건이며(외부API 취소 / CS 폐기 / 발송실패 환불), 여기만 고쳐도 해소되지 않으므로
    //   현행을 따른다 — 격리수준을 올리려면 RefundPoolService 쪽에서 일괄로 해야 한다.
    //
    // ★ 멱등키 prefix 에 id 목록을 그대로 이어붙이면 안 된다.
    //   저장 컬럼은 order_payment_refund_event.idempotency_key / wallet_transaction.idempotency_key 둘 다
    //   varchar(120) 이고, RefundPoolService 가 이 prefix 뒤에 `:line:{id}:point_skipped_expired`(최대 27자)
    //   까지 붙인다. id 를 나열하면 발송건 9건에서 120자를 넘겨 strict 모드는 Data too long(1406) 으로,
    //   비-strict 모드는 잘린 키끼리 uq_refund_event_idempotency 충돌로 트랜잭션이 통째로 롤백된다.
    //   "수신자 수십~수백 명 중 일부만 취소" 가 이 기능의 본래 용도라 그 규모에서 반드시 깨진다.
    //   정렬된 집합의 해시를 쓰면 길이가 입력 크기와 무관하게 고정되고, 같은 집합을 다른 순서로 보내도
    //   같은 키가 되어 재시도 멱등이 유지된다.
    const requestDigest = createHash('sha1').update(requested.join(',')).digest('hex').slice(0, 16);

    // ★ 과금 범위(회사 + 소속 사용자)를 **환불보다 먼저** 잠근다 (리뷰 P2 — 데드락).
    //
    //   아래에서 레거시 미러(회사 예치금 / 사용자 여신)를 증감 UPDATE 하는데, UPDATE 도 그 행에
    //   락을 건다. 즉 이 경로의 실제 순서는 종전에 `주문 → 지갑 → 회사·사용자` 였다.
    //   그런데 발송확정(deliveryConfirmed)은 `주문 → 회사·사용자(lockBillingScope) → 지갑` 이다.
    //   지갑과 회사의 순서가 서로 반대라, 같은 회사의 **서로 다른 주문** 두 건이 동시에 돌면
    //     T1(부분취소): 지갑 잡고 회사 대기
    //     T2(발송확정): 회사 잡고 지갑 대기
    //   로 교착된다. 주문 번호가 달라 주문 락으로는 걸러지지 않는다.
    //
    //   여기서 미리 잡아 순서를 발송확정과 같게 맞춘다. 잠그는 대상·총량은 종전과 같고
    //   (어차피 아래 UPDATE 가 같은 행을 잠근다) 보유 구간만 환불 앞으로 당겨진다.
    //   ※ 환불 구간에는 외부 통신이 없다(전부 DB 작업) — 보유 시간이 크게 늘지 않는다.
    //   ※ 반환값을 쓰지 않고 아래에서 billingUser 를 다시 읽는 것은 의도다. 여기서는 순서를 맞추는
    //     것이 목적이고, 재조회는 환불이 반영된 최신 값을 읽기 위한 것이다(READ COMMITTED).
    await this.lockBillingScope(getBillingUserId(lockedOrder));

    const refundResult = await this.refundPoolService.refund(
      {
        orderId,
        // CS 폐기환불(DISCARD_REFUND) 과 구분한다 — 원장에서 "왜 돈이 돌아왔나" 를 사유별로 추적해야 한다.
        eventType: OrderPaymentRefundEventType.CANCEL,
        targetDeliveryIds: requested,
        idempotencyKeyPrefix: `partial_cancel:${orderId}:${requestDigest}`,
      },
      externalManager,
    );

    // 멱등 hit 이면 원장만 재사용되고 돈은 움직이지 않는다. 그대로 성공 응답을 주면
    // "취소됐고 환불됐다" 고 알리면서 실제로는 0원이 나간다 — 외부 API 취소도 같은 상황을 bail 로 처리한다.
    if (refundResult.alreadyRefunded) {
      this.logger.error(
        `[DELIVERY_CANCEL_REFUND_NOOP] orderId=${orderId} ids=[${requested.join(',')}] ` +
          `digest=${requestDigest} — 멱등 hit 으로 환불 미실행, 취소 롤백`,
      );
      throw new ConflictException(
        '이미 처리된 취소 요청입니다. 발송 상태를 다시 조회한 뒤 남은 대기 건만 취소해 주세요.',
      );
    }

    // ★ 환불 커버리지 검증. cancelDeliveriesIfStillWaiting 은 요청한 발송건을 전부 CANCEL 로 바꾸는데,
    //   RefundPoolService 는 order_payment_allocation_line 이 있는 발송건만 환불한다(라인당 원장 1개).
    //   정상 흐름은 발송건:라인 = 1:1 이라 항상 일치하지만, 라인이 없는 발송건(재발행 대체행 등)이
    //   요청에 섞이면 그 건은 CANCEL 됐는데 환불은 안 되고(고객은 여전히 청구됨) 아무 에러도 없이
    //   200 + "취소 완료" 로그가 나간다. 원장 수(=환불된 라인 수)와 요청 수가 다르면 롤백한다.
    if (refundResult.ledgerIds.length !== requested.length) {
      this.logger.error(
        `[DELIVERY_CANCEL_REFUND_COVERAGE] orderId=${orderId} requested=${requested.length} ` +
          `refundedLines=${refundResult.ledgerIds.length} ids=[${requested.join(',')}] ` +
          `— 일부 발송건에 정산 라인이 없어 미환불, 취소 롤백`,
      );
      throw new ConflictException(
        '취소 대상 중 환불 정보를 찾지 못한 발송건이 있어 처리하지 못했습니다. 아무것도 취소되지 않았습니다. 고객센터로 문의해 주세요.',
      );
    }

    // 레거시 미러 역복원 (전체취소·외부API취소와 동일). RefundPoolService 는 legacy 컬럼을 건드리지
    // 않으므로 이중복원이 아니다. 이게 빠져 있으면 지갑 잔액은 맞는데 고객사 화면·정산 화면의
    // 예치금/여신이 취소 전 값에 멈춰 서로 어긋난다.
    //
    // ★ 재원별 금액은 refund 가 돌려준 값을 그대로 쓴다. `allocation(after) - allocation(before)` 로
    //   역산하면 안 된다 — before 를 락 없이 읽은 뒤 refund 가 wallet/allocation 락을 잡기 때문에,
    //   그 사이 같은 주문의 **다른 발송건을 CS 폐기 등이 환불하면 그 몫까지 차액에 섞인다**.
    //   CS 쪽은 자기 몫을 이미 레거시 미러에 반영하므로, 부분취소가 남의 환불분을 한 번 더
    //   회사 예치금/여신에 적립하는 과다적립이 났다(관리자 리뷰 P1).
    //
    // ★ 이 값이 "이번 호출의 몫" 인 근거는 **바로 위 alreadyRefunded 가드**다.
    //   RefundPoolService.buildRefundResult 는 넘겨받은 원장 행을 합해서 돌려주는데,
    //   호출부 7곳이 `기존 원장 → alreadyRefunded=true` / `이번에 만든 원장 → false` 로
    //   예외 없이 짝지어져 있다. 즉 alreadyRefunded=false 면 반환 금액은 반드시 이번 호출 몫이다.
    //   멱등 hit(=기존 원장 총액이 실려 옴)은 위에서 던져 여기까지 오지 않는다.
    //   ⚠️ 그 가드를 지우면 재시도가 미러에 과다적립된다 — partial-cancel.spec 이 이를 고정한다.
    const depositRefunded = refundResult.refundedDepositAmount;
    const creditRefunded = refundResult.refundedCreditUsedAmount;
    const excessRefunded = refundResult.refundedCreditExcessAmount;

    const billingUserId = getBillingUserId(lockedOrder);
    const billingUser = await this.userRepository.findOneOrFail({
      where: { id: billingUserId },
      relations: ['company'],
    });
    const isCompanyBalanceMode = billingUser.company?.balanceManagementType === 'COMPANY';

    // ★ 두 컬럼 모두 DB 에서 증감시킨다(읽은 값 + 델타를 되쓰지 않는다).
    //   balance / all_settle_amount 는 회사·유저 단위 공유 자원이라 이 주문의 락으로 보호되지 않는다.
    //   같은 고객사의 서로 다른 주문 2건이 동시에 취소되면, 각자 락 밖에서 읽은 값에 자기 델타를 더해
    //   되쓰므로 갱신 하나가 통째로 유실된다(lost update = 환불 한 건이 잔액에 반영되지 않음).
    //   증감식을 DB 에 넘기면 UPDATE 가 행 락 안에서 현재값 기준으로 계산해 유실이 구조적으로 사라진다.
    //   company.balance 는 종전에 save(엔티티 전체)라 다른 필드까지 stale 스냅샷으로 덮어쓸 위험도 있었다.
    if (depositRefunded > 0 && isCompanyBalanceMode && billingUser.company) {
      await this.userCompanyRepository
        .createQueryBuilder()
        .update()
        .set({ balance: () => 'balance + :depositRefunded' })
        .where('id = :id', { id: billingUser.company.id })
        .setParameters({ depositRefunded })
        .execute();
    }
    if (creditRefunded + excessRefunded > 0) {
      // wallet path 는 user.balance 를 건드리지 않으므로 all_settle_amount 만 움직인다.
      await this.userRepository
        .createQueryBuilder()
        .update()
        .set({ allSettleAmount: () => 'all_settle_amount - :creditReturned' })
        .where('id = :id', { id: billingUser.id })
        .setParameters({ creditReturned: creditRefunded + excessRefunded })
        .execute();
    }

    // 남은 발송건이 없으면 주문도 취소로 내린다. 남아 있으면 DELIVERY_CONFIRMED 를 유지해야
    // 잔여분이 정상 발송되고, 전건 터미널이 됐을 때 배치가 완료·정산으로 넘긴다.
    //
    // ★ 취소 축(status)만 보면 안 된다 (197-16 리뷰 P1). 발송건의 생사는 **두 축**이다 —
    //   status(취소됐나)와 coupon_status(폐기됐나). 폐기는 status 를 건드리지 않으므로,
    //   폐기 후 재발행된 원본은 `status=COMPLETE / coupon_status=CANCEL` 로 남는다.
    //   1건 주문을 재발행한 뒤 새 행을 부분취소하면 살아 있는 발송건은 0 인데 죽은 원본이
    //   1 건으로 잡혀, 주문이 DELIVERY_CONFIRMED 로 남고 allocation 도 안 닫힌다(settleAmount 만 0).
    //   정산 표시(buildSettlementDisplayLines)는 이미 그 원본을 빼고 있었다 — 술어를 공유해 맞춘다.
    const remaining = await this.orderDeliveryRepository
      .createQueryBuilder('od')
      .innerJoin('od.orderProductMapping', 'opm')
      .where('opm.orderId = :orderId', { orderId })
      .andWhere('od.status != :canceled', { canceled: IOrderDeliveryStatus.CANCEL })
      .andWhere(notDiscardedReplacedOriginPredicate('od'))
      .getCount();

    // ★ 고객 메일에 쓸 "앞으로 나갈 건수" 는 위 remaining 과 **다른 숫자**다. 재활용하면 안 된다.
    //   remaining 은 "취소 안 된 것 전부" 라 COMPLETE·FAIL 처럼 이미 끝난 건도 센다. 주문을
    //   취소 상태로 내릴지 판단하는 데는 그게 맞다(하나라도 남았으면 주문을 살려 둬야 한다).
    //   그러나 메일은 "남은 건은 예정대로 발송됩니다" 라고 안내하므로 **아직 안 나간 것만** 세야 한다.
    //   이 티켓의 대표 시나리오가 "일부 발송완료 + 일부 대기" 라, 재활용하면 이미 받은 쿠폰·실패 건까지
    //   "앞으로 발송" 으로 안내하는 거짓 메일이 고객에게 나간다(발송완료 1 + 실패 1 + 대기 1 → "3건 발송 예정").
    //   ★ 여기에도 같은 술어를 건다. 폐기 후 재발행은 원본이 WAIT 인 채로 남을 수 있는데(발송 전 폐기),
    //     그러면 죽은 원본과 그 자리를 채운 새 행이 **둘 다** 세어져 "발송 예정 2건" 이라고 안내한다.
    const remainingWaiting = await this.orderDeliveryRepository
      .createQueryBuilder('od')
      .innerJoin('od.orderProductMapping', 'opm')
      .where('opm.orderId = :orderId', { orderId })
      .andWhere('od.status = :wait', { wait: IOrderDeliveryStatus.WAIT })
      .andWhere(notDiscardedReplacedOriginPredicate('od'))
      .getCount();

    // ★ 주문의 정산금액을 "취소 반영 후 값" 으로 맞춘다.
    //   정산정보 입력/수정(createOrderSettle·updateOrderSettle)은 발송확정 이후 주문에 대해
    //   `difference = order.settleAmount - 재계산금액` 만큼 잔액을 조정한다. 재계산 쪽
    //   (buildSettlementDisplayLines)은 이제 취소된 발송건을 빼므로, settleAmount 를 원액으로 두면
    //   그 차이가 통째로 "돌려줄 돈" 으로 잡혀 이미 환불한 취소분이 한 번 더 지급된다.
    //   부분취소가 "발송확정 + 취소된 발송건" 조합의 첫 생산자라 이 경로는 이번에 새로 열렸다.
    //
    //   ★ settleAmount -= totalRefundedAmount(환불 실지급액) 로 빼면 안 된다. 환불액의 카드할증은
    //     payable base(gross - 포인트) 기준인데(refund-pool), 정산 재계산의 할증은 gross 기준이라,
    //     카드할증+포인트 병용 주문에서 그 차이(할증율 × 취소분 포인트)만큼 settleAmount 가 높게 남아
    //     이후 정산수정 difference 가 소액 양수 → 취소분 일부가 다시 환불된다. 정산수정과 "동일한 함수·
    //     동일한 로딩" 으로 재계산해 덮으면 difference 가 정확히 0 이 된다(할증·포인트·반올림 무관).
    if (remaining === 0) {
      // 전건 취소 — 전체취소와 같은 종단 상태를 만든다(다른 코드가 보는 조합을 늘리지 않는다).
      //
      // ★ allocation 도 전체취소와 같은 표현으로 닫는다. 이게 빠지면 released_at 이 NULL 로 남아
      //   isWalletManaged(= EXISTS(allocation WHERE order_id=? AND released_at IS NULL)) 가 계속
      //   true 인 조합 — "주문은 취소됐는데 지갑은 아직 점유 중" — 이 새로 생긴다. 같은 종단 사건이
      //   요청 형태(전체취소 vs 대기건 전량 부분취소)에 따라 두 가지 wallet 표현으로 갈리면
      //   사후 스윕·정산이 둘을 다르게 본다. UI 의 "전체 선택" 은 자연스러운 조작이라 반드시 도달한다.
      //
      //   여기서 돈은 움직이지 않는다. 위에서 발송건별로 이미 전액 환불했고(커버리지 가드가 보장),
      //   releaseConfirmation 은 자원별로 max(0, used - restored) 만, 포인트도
      //   (usedAmount - restoredAmount - skippedExpiredAmount) 만 복구하므로 전부 0 이다.
      //   즉 이 호출의 효과는 released_at/release_reason 기록과 INITIAL attempt 의 ROLLED_BACK 정리뿐이다.
      await this.orderConfirmationReleaseService.releaseConfirmation(
        { orderId, reason: 'order_cancel_partial_all', failedDeliveryIds: null },
        externalManager,
      );
      lockedOrder.status = IOrderStatus.DELIVERY_CANCEL;
      lockedOrder.cancelReason = cancelReason;
      lockedOrder.canceledAt = now;
      lockedOrder.settleAmount = 0;
      lockedOrder.isSettleBalance = false;
      lockedOrder.isCreditExcess = false;
    } else {
      // CAS 로 status=CANCEL 이 이미 반영된 발송건을 같은 트랜잭션에서 재조회해 재계산한다
      // (정산수정과 동일한 계산 함수 calculateOrderSettlementAmount + 부분취소 전용 로더).
      //
      // ※※ [별도 티켓 — 추적 문서: docs/followup-settleamount-basis-inconsistency.md]
      //   (리뷰 LOW 반영: 주석에만 남기면 사라지므로 추적 문서 경로를 코드에 박아 둔다.
      //    티켓 번호가 발급되면 이 줄에 함께 적을 것.)
      //   settleAmount 의 basis 가 코드베이스에서 통일돼 있지 않다.
      //   - 발송확정(wallet 최신, order.service deliveryConfirmed):
      //       settleAmount = allocation.payableSettlementAmount
      //       = (gross - 포인트) + 카드할증(gross - 포인트)   ← 포인트 제외, 할증 base 도 포인트 뺀 값
      //   - 정산수정(createOrderSettle/updateOrderSettle, 살아있는 경로):
      //       settleAmount = calculateOrderSettlementAmount = gross + 카드할증(gross)   ← 포인트 포함
      //   포인트 쓴 주문에서 두 basis 는 (포인트값 + 할증×포인트)만큼 다르다. 이 불일치는 부분취소와
      //   무관한 기존 사안이며(포인트 주문을 발송확정 후 정산수정하면 원래부터 difference 가 어긋날 수
      //   있음), 실제 잔액 오조정까지 가는지는 "정산수정 difference 블록이 이 wallet 주문들에 실제로
      //   도는지 + 도면 포인트만큼 오조정되는지" 를 정산 담당과 확인해야 한다. → 별도 티켓.
      //
      //   여기서 wallet 관례(payableSettlementAmount)가 아니라 calculateOrderSettlementAmount 를
      //   쓰는 이유: 부분취소발 이중환불을 실제로 일으키는 것이 정산수정의 difference 블록이고, 그 블록이
      //   비교 기준으로 쓰는 함수가 바로 calculateOrderSettlementAmount 다. 같은 함수로 맞춰야
      //   difference = 0 이 되어 이중환불이 사라진다. payableSettlementAmount 로 맞추면 basis 가 어긋나
      //   이중환불이 되살아난다. 즉 "버그를 일으키는 그 경로" 와 basis 를 일치시키는 것이 정답이다.
      //   (basis 통일은 위 별도 티켓에서 정산수정·발송확정을 한꺼번에 정리하는 게 맞다.)
      //   ★ 로더는 부분취소 전용(getOrderProductsForCancelSettlement)을 쓴다. 정산수정과 공유하는
      //     innerJoin 로더를 쓰면 주문 이후 소프트삭제된 상품의 매핑이 통째로 빠져 settleAmount 가
      //     과소(전부 삭제면 0)로 저장되고, 이후 전체취소가 그 값을 환불액으로 읽어 무·과소환불이 된다.
      //     자세한 근거는 그 메서드의 주석 참조.
      const survivingMappings = await this.getOrderProductsForCancelSettlement(orderId);
      const recomputedSettleAmount = calculateOrderSettlementAmount(
        { cardSurchargeApplied: lockedOrder.cardSurchargeApplied, orderProductMappings: survivingMappings },
        lockedOrder.cardSurchargeApplied,
      );

      // 단가를 **복원할 근거가 없는** 매핑이 있으면 던져서 롤백한다.
      //
      // readLineProductView 는 snapshotProductPrice ?? product?.price ?? 0 순으로 폴백하는데,
      // 스냅샷도 없고(스냅샷 도입 이전 주문) 상품도 소프트삭제된 매핑은 마지막 0 으로 떨어진다.
      // 그 0 을 조용히 저장하면 이후 전체취소가 그것을 환불액으로 읽어(신흐름 refundAmount =
      // order.settleAmount) "취소는 되고 환불은 0원" 이 된다 — 돈이 걸린 침묵이라 막는다.
      // 이 주문은 전체취소로 처리하면 된다(그 경로는 settleAmount 를 덮지 않은 원본값으로 환불한다).
      //
      // ★ 판정 기준을 "재계산 결과가 0" 으로 두면 안 된다. 정당한 0원 정산 주문(무료 프로모션,
      //   전액할인)이 같은 값을 내는데, 그걸 막으면 그 주문은 전체취소로 밀려나고 전체취소는
      //   refundAmount(0) > 0 단락평가로 wallet 경로를 건너뛰어 allocation.released_at 이 NULL 로
      //   남는다 — 이 브랜치가 막으려던 바로 그 drift 로 유도된다. 그래서 "값이 0인가" 가 아니라
      //   "근거가 없는가"(스냅샷·상품 둘 다 부재)로 좁힌다.
      const unresolvableMappings = survivingMappings.filter(
        (mapping) => mapping.snapshotProductPrice == null && mapping.product == null,
      );
      if (unresolvableMappings.length > 0) {
        this.logger.error(
          `[DELIVERY_CANCEL_SETTLE_RECALC] orderId=${orderId} 잔여=${remaining}건 — 단가 복원 근거가 없는 ` +
            `매핑 ${unresolvableMappings.length}건(스냅샷·상품 모두 부재) mappingIds=` +
            `[${unresolvableMappings.map((mapping) => mapping.id).join(',')}] → 롤백(무·과소환불 차단)`,
        );
        throw new InternalServerErrorException(
          '취소 후 정산금액을 계산하지 못해 처리하지 못했습니다. 아무것도 취소되지 않았습니다. ' +
            '주문 전체 취소를 이용하거나 고객센터로 문의해 주세요.',
        );
      }
      lockedOrder.settleAmount = recomputedSettleAmount;

      // ★ 여기서 isSettleBalance / isCreditExcess 는 **일부러 건드리지 않는다** (1차 리뷰 LOW —
      //   "remaining === 0 분기와 비대칭" 지적에 대한 답. 모양이 다른 것은 상황이 다르기 때문이다).
      //
      //   이 플래그는 두 가지를 겸한다. 이름만 보면 앞엣것만 같지만 실제 판정은 뒤엣것으로 쓰인다.
      //     ① 결제 수단   : 예치금(선입금)으로 냈나(true) / 여신으로 냈나(false)
      //     ② 미환불 표시 : 아직 돌려주지 않았다. 환불하고 나면 내려서 이중 환불을 막는다.
      //   ②의 증거는 전체취소 legacy 분기다 — 예치금으로 돌려준 **직후** isSettleBalance=false 로
      //   내린다(:6576-6582). 수단이 바뀐 것이 아니라 "처리 끝" 을 적는 것이다.
      //
      //   그래서 판단 기준은 "수단이 바뀌었나" 가 아니라 **"이 주문에 아직 돌려줄 게 남았나"** 다.
      //     전체취소            : 전액 환불 → 내린다
      //     부분취소(잔여 있음) : 남은 건은 아직 안 돌려줬다 → **내리면 안 된다**  ← 여기
      //     부분취소(잔여 0)    : 결과적으로 전액 환불 → 전체취소와 같은 종단 상태로 내린다
      //
      //   내리면 실제로 돈이 잘못 간다. 이 플래그를 읽는 곳이 셋이고 전부 "어디로 돌려줄까" 를 정한다:
      //     · CS 폐기환불   customer.service.service (shouldRestoreBalance = isSettleComplete || isSettleBalance)
      //     · 배치 실패환불 delivery.batch.service (같은 판정)
      //     · 자동 정산확정 delivery.batch.service (isSettleBalance=true 만 SETTLE_COMPLETE)
      //   예치금으로 낸 주문에서 이 값을 false 로 내리면, 남은 발송건을 CS 가 폐기환불할 때
      //   예치금을 복원하지 않고 여신(allSettleAmount)을 깎는다 — 고객사 예치금은 안 돌아온다.
    }
    await this.orderRepository.save(lockedOrder);

    // 금액을 남긴다 — 돈이 오간 엔드포인트에서 "얼마를 돌려줬나" 를 원장 조회 없이 답할 수 있어야 한다.
    // ★ refunded(=totalRefundedAmount)는 gross 기준 총액이라 **포인트 복구분을 포함**한다.
    //   괄호 안 재원별 분해는 allocation 델타에서 읽은 값이라 포인트가 빠져 있어, 포인트를 쓴 주문에서는
    //   합이 총액과 다르다. 차이는 포인트 복구분이다(둘 다 정확한 값 — 기준이 다를 뿐).
    this.logger.log(
      `[DELIVERY_CANCEL] 부분취소 완료 orderId=${orderId} canceled=${requested.length}건 ` +
        `refunded=${refundResult.totalRefundedAmount}원(포인트 포함 총액) ` +
        `내역: 예치금=${depositRefunded} 여신=${creditRefunded} 신용초과=${excessRefunded} ` +
        `ids=[${requested.join(',')}] 잔여=${remaining}건`,
    );

    // 고객사 직접주문(DIRECT) 은 전체취소와 마찬가지로 통지한다 — 돈이 돌아갔는데 외부에 기록이
    // 남지 않으면 안 된다.
    // ★ 잔여가 0이면(대기 건을 전량 취소) 위에서 주문을 DELIVERY_CANCEL 로 내려 사실상 전체취소다.
    //   이때 부분취소 문안("일부 취소, 남은 0건")을 보내면 고객에게 모순된 안내가 나가므로
    //   전체취소 문안("주문이 취소되었습니다")으로 보낸다. 잔여가 있으면 부분취소 전용 문안.
    // ★ @Transactional() 안이므로 커밋 후 발송 — tx 미점유, 롤백 시 미발송. best-effort.
    if (isDirectCustomerCancelTarget(lockedOrder, billingUser)) {
      runOnTransactionCommit(() => {
        if (remaining === 0) {
          void this.orderCancelNotificationService.notifyDirectOrderCancel(lockedOrder, billingUser);
        } else {
          void this.orderCancelNotificationService.notifyDirectOrderPartialCancel(lockedOrder, billingUser, {
            canceledCount: requested.length,
            // 메일은 "예정대로 발송" 안내라 대기 건수만 넘긴다(remaining 은 이미 끝난 건도 센다).
            waitingCount: remainingWaiting,
            cancelReason,
            canceledAt: now,
          });
        }
      });
    }

    // 돈이 오간 요청이므로 결과를 응답으로도 돌려준다 — 로그에만 남기면 클라이언트가
    // "무엇이 취소됐고 얼마가 돌아갔는지" 를 대사할 방법이 없다.
    // 전량 거부 정책상 canceledIds 는 항상 요청 집합과 같지만(부분 성공 없음), 정렬·중복제거된
    // 실제 처리 대상을 그대로 내려 클라이언트가 자기 요청과 대조할 수 있게 한다.
    return {
      canceledIds: requested,
      refundedAmount: refundResult.totalRefundedAmount,
      remaining,
    };
  }

  /**
   * ★ READ COMMITTED 로 고정한다 (리뷰 P1). 기본값(MySQL REPEATABLE READ)이면 자금이 어긋난다.
   *
   * REPEATABLE READ 는 트랜잭션의 **첫 비잠금 SELECT** 시점 스냅샷을 끝까지 보여준다. 잠금 읽기
   * (FOR UPDATE)와 UPDATE 는 최신을 보므로, 한 트랜잭션 안에서 두 종류가 섞이면 앞뒤가 어긋난다.
   * 이 경로는 정확히 그 형태다 — 락으로 직렬화해 놓고, 정작 판단은 비잠금 SELECT 로 한다.
   *
   * 실제로 어긋나는 곳:
   *  1) 주문 행을 두 번 읽는다. 잠금 조회(존재확인+직렬화)와 그래프 조회(실제 사용)가 분리돼 있는데,
   *     뒤엣것이 스냅샷을 본다. 락을 기다리는 동안 부분취소가 settleAmount 를 낮추고 커밋해도
   *     낮아지기 전 값을 읽어 그 금액으로 환불한다.
   *  2) 취소 후 정산 재계산이 다른 발송건 상태를 비잠금으로 읽는다. 같은 주문의 다른 발송건을
   *     먼저 취소한 트랜잭션이 커밋됐어도 그 건을 아직 살아 있는 것으로 세어 금액을 부풀린다.
   *  3) RefundPoolService 는 "락 잡고 → 다시 읽어 중복 확인" 방식이라 호출자에게 READ COMMITTED 를
   *     명시적으로 요구한다(refund-pool.service.ts). 외부 manager 를 넘기는 이 경로가 그 요구를
   *     지키지 않고 있었다 — 스냅샷을 보면 재확인이 옛 값을 봐서 중복 확인이 무력화된다.
   *
   * 대안으로 "잠금 읽기를 먼저 두어 스냅샷 시점을 뒤로 미루기" 도 가능하지만, 그건 **어디에도 적혀
   * 있지 않은 순서 규칙**("락보다 앞에 비잠금 SELECT 를 두지 마라")에 계속 기대는 방식이다.
   * 실제로 소유권 검증 한 줄이 앞에 들어가면서 그 규칙이 깨졌던 전례가 있다. 격리수준으로 내리면
   * 스냅샷 자체가 없어져 순서에 의존하지 않는다.
   *
   * 안전성 근거: 이 트랜잭션이 직접 수행하는 읽기 13곳을 전수 확인했고, "같은 값을 두 번 읽고
   * 동일함을 전제" 하는 코드는 없다. 두 번 읽는 두 곳(취소가능 조회↔CAS, 잠금조회↔그래프조회)은
   * 모두 값이 달라질 수 있다는 전제로 쓰여 있어(affected 대조 / 위 1번) 낮추면 오히려 정확해진다.
   */
  @Transactional({ isolationLevel: IsolationLevel.READ_COMMITTED })
  async deliveryCancel(user: ILoginUserInfo, getBody: OrderDeliveryCancelReqDto) {
    const { id, cancelReason, deliveryIds } = getBody;

    // ★ 소유권(조회범위) 검증 — 이 엔드포인트는 클래스 가드가 JWT 유효성만 보고, 서비스의
    //   order.userId 조건도 주석 처리돼 있어 **인증된 아무나 주문 id 만 알면 타 테넌트의 예약
    //   발송을 취소**시킬 수 있었다(관리자 리뷰 P1 보안). 자금·비가역 경로이므로 조회 API 와
    //   같은 기준(applyViewScopeFilter)으로 막는다.
    //   ※ canTransitionDelivery(발송확정 권한)를 쓰지 않는 이유: 그 술어는 SUPER/OPERATION 전용이라
    //     자기 주문을 취소하던 고객사(CORPORATE_ADMIN)가 전부 막혀 동작이 바뀐다. 여기서 필요한 것은
    //     "남의 주문을 못 건드린다" 이므로 조회범위 기준이 정확하고 기존 동작을 보존한다.
    //   ※ 전체취소·부분취소 **양쪽 앞**에 둔다 — 부분취소는 user 를 받지도 않아 검사 자체가 없었다.
    //   ※ 같은 화면의 인접 액션(reviewComplete·deliveryConfirmed)은 canTransitionDelivery(권한 기준)로
    //     판정한다. 여기와 술어가 다른 것은 **의도된 차이**다 — 위 이유로 취소는 권한이 아니라 조회범위를
    //     본다. 다만 결과적으로 "스코프 밖 직발송 건을 운영자가 발송확정은 되는데 취소는 안 되는" 조합이
    //     생긴다(되돌릴 수 없는 쪽이 더 느슨한 역전). UI 에 그 id 획득 경로가 없어 지금은 드러나지
    //     않지만, 두 술어를 통일한다면 그건 발송확정 쪽을 조이는 방향이어야 한다.
    //   ※ 거부는 403 이 아니라 400('주문이 존재하지 않습니다') 이다 — 조회 API 와 같은 응답이라
    //     "그 주문이 존재하는지" 자체를 알려주지 않는다(id 순회로 존재 여부를 캐는 것까지 막는다).
    await this.assertOrderInViewScope(user, id);

    // deliveryIds 를 준 요청은 부분취소 경로로 보낸다.
    // 주지 않으면 아래 전체취소가 종전과 동일하게 동작한다 — 기존 프론트는 영향을 받지 않는다.
    if (deliveryIds && deliveryIds.length > 0) {
      return this.partialDeliveryCancel(id, deliveryIds, cancelReason);
    }

    // 주문 행 단독 잠금 (deliveryConfirmed 와 동일 패턴).
    //  - 조인을 건 채로 FOR UPDATE 를 걸면 product 행까지 잠겨, 같은 상품을 쓰는 무관한 주문들이
    //    직렬화된다. 그래서 잠금 쿼리와 그래프 로딩 쿼리를 분리한다.
    //  - 락 위치가 맨 앞인 것이 중요하다. 종전에는 order 행 잠금이 맨 끝 save() 시점에야 잡혀
    //    "wallet → order" 순서였고, 이는 "order → wallet" 으로 잡는 정산확정
    //    (tryAtomicSettleConfirm)·발송확정과 순서가 역전돼 데드락 소지가 있었다.
    const lockedOrder = await this.orderRepository
      .createQueryBuilder('order')
      .setLock('pessimistic_write')
      .where('order.id = :id', { id })
      .getOne();

    if (!lockedOrder) {
      throw new BadRequestException('해당 주문건은 존재하지 않습니다.');
    }

    const order = await this.orderRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .where('order.id = :id', { id })
      // .andWhere('order.userId = :userId', { userId: user.id })
      // .andWhere('order.status = :status', { status: 'DELIVERY_REQUEST' })
      .getOne();

    if (!order) {
      throw new BadRequestException('해당 주문건은 존재하지 않습니다.');
    }

    // 과금 대상 userId 결정 (대행주문인 경우 clientUserId, 아니면 userId)
    const billingUserId = order.clientUserId ?? order.userId;

    const oneUser = await this.userRepository.findOneOrFail({
      where: {
        id: billingUserId,
      },
      relations: ['company'],
    });

    // balanceManagementType에 따른 balance 관리 모드 결정
    const isCompanyBalanceMode = oneUser.company?.balanceManagementType === 'COMPANY';

    const now = new Date();
    // 취소 기준 시각: 예약 mapping들의 sendRequestAt 중 가장 이른 시각 사용
    // 상품 행별 예약시각이 서로 다를 수 있으므로, 가장 임박한(이른) 발송 건을 기준으로 보호한다.
    //
    // ★ 이미 전부 취소된 상품행은 제외한다. 그 행의 예약시각은 보호할 대상이 없는데도 최솟값을
    //   과거로 끌어내려, 여유가 충분한 나머지 예약건까지 영구히 취소 불가로 만든다(리뷰 P2).
    //   부분취소가 "예약시각은 지났는데 발송은 안 된 행" 을 처음 만들면서 생긴 조합이다.
    const activeMappingIds = await this.findMappingIdsWithActiveDeliveries(order.id);
    const reserveSendTimes = (order.orderProductMappings ?? [])
      .filter((mapping) => mapping.sendType === 'RESERVE' && mapping.sendRequestAt)
      .filter((mapping) => activeMappingIds.has(mapping.id))
      .map((mapping) => mapping.sendRequestAt!.getTime());

    // ★ 보호할 예약건이 하나도 없으면 컷오프는 **적용 대상이 아니다**(null).
    //   종전에는 이 자리에 0(1970년)을 넣어 "지난 지 한참" 으로 계산했다. 예약행이 하나도 없는
    //   주문에서는 어차피 위 countIrreversibleDeliveries 가 먼저 막아 드러나지 않았지만,
    //   취소된 행을 걸러내기 시작하면 "예약행이 전부 취소됨" 상태가 새로 만들어져 같은 자리에서
    //   또 영구 차단이 난다 — 고치려던 결함을 자리만 옮기는 꼴이다.
    //   시각이 없다는 것과 시각이 과거라는 것은 다른 사실이므로 값도 다르게 둔다.
    const sendRequestAtTime = reserveSendTimes.length > 0 ? Math.min(...reserveSendTimes) : null;
    const nowTime = now.getTime();
    const diffMs = sendRequestAtTime === null ? null : sendRequestAtTime - nowTime;
    const tenMinutesMs = 10 * 60 * 1000;

    if (order.status === IOrderStatus.DELIVERY_REQUEST || order.status === IOrderStatus.REVIEW_COMPLETE) {
      // 주문완료 또는 검토완료 상태에서 취소 허용
    } else if (order.status === IOrderStatus.DELIVERY_CONFIRMED) {
      // ★ 이미 나간 건이 섞여 있으면 주문 전체 취소를 거부한다.
      //
      // 아래 실행부는 주문의 모든 발송건을 상태 무관하게 CANCEL 로 덮고 settleAmount 전액을
      // 환불한다. 그런데 바로 위 10분 게이트는 sendType === 'RESERVE' 인 상품행만 보므로,
      // 즉시발송 상품행(이미 발송완료) + 예약 상품행(아직 대기) 이 섞인 주문은 게이트를
      // 통과한다 — 예약분의 여유(예: 하루 뒤)만 보고 판정하기 때문이다.
      // 그 결과 이미 고객 손에 간 쿠폰이 CANCEL 로 덮이고 그 몫까지 환불된다(응답 200, 로그 없음).
      //
      // 발송확정 이후에만 검사하면 된다. 그 전(DELIVERY_REQUEST/REVIEW_COMPLETE)에는
      // 발송건이 아직 TEMP 라 나간 것이 있을 수 없고 잔액 차감도 없다.
      const irreversible = await this.countIrreversibleDeliveries(order.id);
      if (irreversible > 0) {
        this.logger.error(
          `[DELIVERY_CANCEL] orderId=${order.id} 되돌릴 수 없는 발송건 ${irreversible}건 포함 — 주문 전체 취소 거부`,
        );
        throw new ConflictException(
          `이미 발송됐거나 쿠폰이 발급된 발송건이 ${irreversible}건 있어 주문 전체를 취소할 수 없습니다. ` +
            '발송 결과를 확인한 뒤 고객센터를 통해 개별 처리해 주세요.',
        );
      }

      // diffMs === null 이면 아직 살아 있는 예약건이 없다는 뜻이라 이 게이트의 판정 대상이 아니다.
      // (이미 나간 건은 바로 위 countIrreversibleDeliveries 가 막는다 — 여기서 또 막을 이유가 없다.)
      if (diffMs !== null && diffMs < tenMinutesMs) {
        throw new BadRequestException('주문 취소는 발송 요청 시간 10분 전까지만 가능합니다.');
      }
    } else {
      throw new BadRequestException('주문 취소가 불가능한 상태입니다.');
    }

    if (!order.orderProductMappings || order.orderProductMappings.length === 0) {
      throw new BadRequestException('발송 상세가 존재하지 않습니다.');
    }

    const orderProductMappingIdList = order.orderProductMappings!.map((orderProductMapping) => orderProductMapping.id);

    // 삭제된 상품이 포함된 주문도 취소는 허용해야 한다(취소는 오히려 더 허용되어야 하는 동작).
    // 환불 단가는 주문 시점 스냅샷(snapshotProductPrice) → LIVE 상품가 → 0 순으로 폴백한다(readLineProductView 패턴 동일).
    const totalPrice = order.orderProductMappings!.reduce((acc, cur) => {
      return acc + readLineProductView(cur).price * cur.amount;
    }, 0);

    // SSG 주문인 경우 이벤트 잔액 복구 (새/기존 흐름 공통)
    if (order.type === IOrderType.SSG) {
      await this.ssgEventService.restoreEventBalance(order.id);
      // ★ addBalance() 호출 삭제 — 아래 통합 블록에서 oneUser 엔티티를 통해 처리
      // 기존 addBalance()는 DB를 직접 수정하지만, 이후 save(oneUser)가 stale 스냅샷으로 덮어씀
    }

    // 환불 금액 결정
    // - 새 흐름: 발송확정(DELIVERY_CONFIRMED) 후에만 settleAmount(할인가) 기준 환불
    //           발송확정 전(DELIVERY_REQUEST, REVIEW_COMPLETE)은 잔액 차감 없었으므로 환불 불필요
    // - 기존 흐름: 항상 정가(totalPrice) 기준 환불
    let refundAmount = 0;
    if (order.isNewBillingFlow) {
      if (order.status === IOrderStatus.DELIVERY_CONFIRMED) {
        refundAmount = order.settleAmount;
      }
    } else {
      refundAmount = totalPrice;
    }

    // Wallet Cutover Bundle (PR2-005) — wallet-managed 주문은 OrderConfirmationReleaseService 로 일괄 보상.
    // 라우팅: allocation 존재 + released_at IS NULL → wallet path (flag mode 무관, allocation routing > flag).
    const externalManager = this.orderRepository.manager;
    // ★ 여기에 refundAmount > 0 을 걸면 안 된다(리뷰 P2). "지갑을 쓰는 주문인가" 와 "돌려줄 돈이
    //   있는가" 는 다른 질문인데, && 로 묶으면 0원 주문이 지갑 경로 자체를 건너뛴다.
    //   그러면 releaseConfirmation 이 호출되지 않아 allocation.released_at 이 NULL 로 남는다 —
    //   주문·발송건은 CANCEL 인데 지갑은 "아직 진행 중" 인 상태가 되고, isWalletManaged 판정이
    //   계속 true 라 이후 경로들이 이 주문을 미결로 본다. INITIAL attempt 도 닫히지 않는다.
    //   0원이 나오는 실제 경로: 무료·100% 할인 잔여분, 부분취소 후 남은 것이 0원인 경우.
    //   금액 판단은 releaseConfirmation 이 이미 한다 — restore 금액이 0 이면 지갑을 건드리지 않고
    //   released_at 만 찍는다(order-confirmation-release.service.ts: `if (restoreDeposit > 0)`).
    //   즉 0원에 호출해도 돈은 움직이지 않고 도장만 찍힌다.
    const isWalletManaged = await this.walletManagedPredicate.isWalletManaged(order.id, externalManager);

    // ★ 레거시 미러(회사 예치금 / 사용자 예치금·여신)에 **얼마를 움직였는지**만 모은다 (197-16 리뷰 P1).
    //   종전에는 엔티티 필드를 메모리에서 증감한 뒤 save 로 통째 저장했다. 그러면 UPDATE 가
    //   `balance = 60000` 같은 **절대값**이 되는데, 그 값은 트랜잭션 시작 전에 락 없이 읽은 것이다.
    //   같은 고객사의 **서로 다른 주문** 두 건이 동시에 취소되면 둘 다 같은 옛 값을 읽고 각자
    //   자기 델타를 더해 되쓰므로, 나중에 커밋한 쪽이 앞의 반영을 통째로 덮는다(lost update).
    //   지갑 원장은 두 건 다 맞는데 화면·정산 잔액만 한 건분 모자란다 — 에러도 로그도 없다.
    //   아래에서 `balance = balance + :delta` 로 넘기면 DB 가 행 락 안에서 현재값 기준으로
    //   계산하므로 순서와 무관하게 정확해진다(부분취소가 이미 쓰는 방식과 통일).
    //   ※ 메모리 증감은 그대로 둔다 — 취소 통지 등 뒤쪽 코드가 oneUser 를 그대로 쓴다.
    let companyBalanceDelta = 0;
    let userBalanceDelta = 0;
    let allSettleDelta = 0;

    if (isWalletManaged) {
      const allocation = await externalManager.findOne(OrderPaymentAllocationEntity, {
        where: { orderId: order.id },
      });
      if (!allocation) {
        throw new InternalServerErrorException(`wallet-managed but allocation row missing for orderId=${order.id}`);
      }
      const depositRefund = Math.max(0, allocation.depositUsedAmount - allocation.depositRestoredAmount);
      const creditRefund = Math.max(0, allocation.creditUsedAmount - allocation.creditUsedRestoredAmount);
      const excessRefund = Math.max(0, allocation.creditExcessAmount - allocation.creditExcessRestoredAmount);

      await this.orderConfirmationReleaseService.releaseConfirmation(
        {
          orderId: order.id,
          reason: 'order_cancel',
          failedDeliveryIds: null,
        },
        externalManager,
      );

      // legacy mirror reverse (wallet path — user.balance 미기록).
      if (isCompanyBalanceMode && oneUser.company) {
        oneUser.company.balance += depositRefund;
        companyBalanceDelta += depositRefund;
      }
      oneUser.allSettleAmount -= creditRefund + excessRefund;
      allSettleDelta -= creditRefund + excessRefund;
      order.settleAmount = 0;
      order.isSettleBalance = false;
      order.isCreditExcess = false;
    } else if (refundAmount > 0) {
      if (order.isSettleBalance) {
        if (isCompanyBalanceMode && oneUser.company) {
          oneUser.company.balance += refundAmount;
          companyBalanceDelta += refundAmount;
        } else {
          oneUser.balance += refundAmount;
          userBalanceDelta += refundAmount;
        }
        order.isSettleBalance = false;
        // legacy deposit sync (!isWalletManaged 분기 전용 — wallet path 는 위 releaseConfirmation 이 예치금 복구).
        await this.legacyWalletCreditSyncService.syncDeposit(externalManager, {
          billingUserId,
          orderId: order.id,
          delta: refundAmount,
          type: 'DISCARD_REFUND',
          idempotencyKey: `legacy_discard_refund:${order.id}:deposit`,
          memo: `레거시 취소 선입금환불 (주문번호: ${order.id})`,
        });
      } else {
        oneUser.allSettleAmount -= refundAmount;
        allSettleDelta -= refundAmount;
        // legacy credit sync (여신복구 — allSettleAmount 감소를 여신 잔액에 반영).
        await this.legacyWalletCreditSyncService.syncCredit(externalManager, {
          billingUserId,
          orderId: order.id,
          delta: -refundAmount,
          type: 'DISCARD_REFUND',
          memo: `레거시 취소 여신복구 (주문번호: ${order.id})`,
        });
      }
    }

    order.status = IOrderStatus.DELIVERY_CANCEL;
    order.cancelReason = cancelReason;
    order.canceledAt = new Date();
    await this.orderRepository.save(order);
    // 발송건에도 취소 시각·사유를 남긴다. 부분취소만 채우고 전체취소는 비워두면
    // canceled_at IS NULL 이 "미취소" 와 "주문 전체취소" 두 가지를 뜻하게 되어,
    // 그 컬럼으로 취소 여부를 판정하는 코드가 전체취소 건을 통째로 놓친다.
    //
    // ★ 이미 CANCEL 인 행은 건드리지 않는다. 부분취소로 먼저 취소된 발송건이 있는 주문을
    //   이어서 전체취소하면(도달 가능 — 부분취소는 주문을 DELIVERY_CONFIRMED 로 남긴다),
    //   조건 없는 UPDATE 가 그 건의 사유·시각을 전체취소 값으로 덮어써 발송건별 취소이력이
    //   사라진다. 발송건 단위 컬럼을 만든 이유(주문 단위 컬럼은 마지막 사유가 앞선 사유를
    //   덮어쓴다)가 그대로 재현되는 셈이다. 로컬 QA 에서 실제로 재현했다.
    //   soft-delete 된 행도 제외한다 — update() 는 deleted_at 필터를 자동 적용하지 않는다.
    //
    // ★ 사전 조회(countIrreversibleDeliveries)는 **안전의 근거가 아니다** (197-16 리뷰 P1).
    //   그건 그 순간의 사진이라, 0 건을 확인한 직후에도 발송 배치가 WAIT 행을 집어(claimed_at)
    //   외부 발급·발송을 시작할 수 있다. 그래서 갱신이 같은 조건을 **다시** 본다(술어 공유).
    //   ※ 조건이 늘었으므로 정상 취소가 막히지 않는지가 관건인데, 여기 걸리는 행은 사전 조회도
    //     거부하는 행과 같다(같은 술어). 늘어난 건 "그 사이에 생긴 것" 뿐이다.
    // ★ 변형 lease 도 함께 본다. 부분취소 CAS 와 같은 이유이며(그쪽 SET 주석 참조), 통과시킨
    //   stale lease 는 SET 으로 탈취해 뒤늦게 돌아온 좀비의 쓰기를 affected=0 으로 만든다.
    const mutationStale = new Date(Date.now() - MUTATION_CLAIM_STALE_MS);
    await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({
        status: IOrderDeliveryStatus.CANCEL,
        canceledAt: order.canceledAt,
        cancelReason,
        mutationClaimedAt: order.canceledAt,
      })
      .where('orderProductMappingId IN (:...mappingIds)', { mappingIds: orderProductMappingIdList })
      .andWhere('status != :canceled', { canceled: IOrderDeliveryStatus.CANCEL })
      .andWhere('deletedAt IS NULL')
      .andWhere(`NOT ${irreversibleDeliveryPredicate()}`, IRREVERSIBLE_TERMINAL_PARAMS)
      .andWhere('(mutationClaimedAt IS NULL OR mutationClaimedAt < :mutationStale)', { mutationStale })
      // ★ 컷오버 배제 술어 (197-16 재리뷰 F1). 이 UPDATE 가 조건부 CAS 가 되면서 부분취소와
      //   **같은 성격**이 됐다 — WAIT 을 선점해 CANCEL 로 바꾸고 그것을 근거로 환불하는 legacy
      //   claim CAS. §9 quiesce 계약(legacy.delivery.entry.point.ts)은 이 술어를 legacy claim CAS
      //   에 반드시 함께 싣도록 규정한다. 없으면 컷오버를 켜는 순간 Level A 슬롯 모델이 잡고 있는
      //   건을 legacy 전체취소가 함께 잡아 **중복 환불**이 뚫린다.
      //   ※ 조건부 UPDATE 로 바뀌기 전(무조건 UPDATE)에는 이 술어를 실을 자리 자체가 없었다.
      //     e3cf9868 이 CAS 로 바꾸면서 형제(부분취소 CAS)와 비대칭이 생겼고 여기서 메운다.
      //   ※ 여기 걸려 빠진 행은 아래 사후검사가 잡아 409 로 되돌린다 — 조용히 새지 않는다.
      .andWhere(NOT_CUTOVER_ORDER_DELIVERY)
      .execute();

    // ★ 사후 검사 — 갱신 건수를 비교하지 않고 **결과 상태**로 묻는다.
    //   부분취소는 "몇 건을 취소할지" 를 알고 시작하니 affected 와 요청 수를 맞대면 되지만,
    //   전체취소는 그 수를 모른다. 대신 이 시점에 지켜야 할 것은 하나뿐이다 —
    //   **취소 안 된 발송건이 0 건이어야 한다.** 위 조건에 걸려 빠진 행이 하나라도 있으면
    //   그 주문은 "전체취소" 가 아니게 되는데, 환불은 전액으로 나간다. 던져서 되돌린다.
    //   (soft-delete 된 행은 SelectQueryBuilder 가 자동으로 뺀다)
    const notCanceled = await this.orderDeliveryRepository
      .createQueryBuilder('od')
      .where('od.orderProductMappingId IN (:...mappingIds)', { mappingIds: orderProductMappingIdList })
      .andWhere('od.status != :canceled', { canceled: IOrderDeliveryStatus.CANCEL })
      .getCount();
    if (notCanceled > 0) {
      this.logger.error(
        `[ORDER_CANCEL_PARTIAL_UPDATE] orderId=${order.id} 취소되지 않은 발송건 ${notCanceled}건 남음 — ` +
          `조회~갱신 사이에 발송 단계로 넘어갔거나 다른 작업이 점유 중. 전체취소 롤백`,
      );
      throw new ConflictException(
        '취소 처리 중 일부 발송건이 발송 단계로 넘어갔거나 다른 작업이 진행 중입니다. ' +
          '아무것도 취소되지 않았습니다. 발송 상태를 다시 조회해 주세요.',
      );
    }
    // ★ 레거시 미러는 **DB 증감식**으로 반영한다 (197-16 리뷰 P1 — 위 델타 주석 참조).
    //   읽은 값 + 델타를 되쓰면 같은 고객사의 다른 주문이 그 사이에 반영한 몫이 통째로 사라진다.
    //   `x = x + :delta` 로 넘기면 UPDATE 가 행 락 안에서 현재값 기준으로 계산해 유실이 없어진다.
    //   ※ 델타가 0 이면 쿼리를 보내지 않는다 — 불필요한 행 락을 잡지 않기 위해서다.
    //   ※ save(oneUser) 통짜 저장을 걷어낸 것이기도 하다. 그건 이 트랜잭션이 건드리지도 않은
    //     다른 컬럼까지 락 없이 읽은 스냅샷 값으로 덮어쓸 수 있었다(wallet 경로가 이미 update 로
    //     좁혀 둔 이유와 같다 — 이제 두 경로가 같은 방식이 된다).
    if (allSettleDelta !== 0) {
      await this.userRepository
        .createQueryBuilder()
        .update()
        .set({ allSettleAmount: () => 'all_settle_amount + :allSettleDelta' })
        .where('id = :id', { id: oneUser.id })
        .setParameters({ allSettleDelta })
        .execute();
    }
    if (userBalanceDelta !== 0) {
      await this.userRepository
        .createQueryBuilder()
        .update()
        .set({ balance: () => 'balance + :userBalanceDelta' })
        .where('id = :id', { id: oneUser.id })
        .setParameters({ userBalanceDelta })
        .execute();
    }
    if (companyBalanceDelta !== 0 && oneUser.company) {
      await this.userCompanyRepository
        .createQueryBuilder()
        .update()
        .set({ balance: () => 'balance + :companyBalanceDelta' })
        .where('id = :id', { id: oneUser.company.id })
        .setParameters({ companyBalanceDelta })
        .execute();
    }

    // 고객사 직접주문(DIRECT) 취소 시 주문자 대표 이메일로 통지.
    // ★ deliveryCancel 은 @Transactional() 이므로 커밋 후(runOnTransactionCommit) 발송 — tx 미점유, 롤백 시 미발송. best-effort.
    if (isDirectCustomerCancelTarget(order, oneUser)) {
      runOnTransactionCommit(() => {
        void this.orderCancelNotificationService.notifyDirectOrderCancel(order, oneUser);
      });
    }

    return;
  }

  private async getCurrentDeliveryTransitionUser(
    userId: number,
  ): Promise<Pick<UserEntity, 'id' | 'authority' | 'status' | 'authorityList'>> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      select: ['id', 'authority', 'status', 'authorityList'],
    });
    if (!user) {
      throw new ForbiddenException('유저가 존재하지 않습니다.');
    }
    return user;
  }

  async updateOperationUser(getBody: OrderUpdateOperationUserReqDto) {
    const { id, operationUserId } = getBody;

    const order = await this.orderRepository.createQueryBuilder('order').where('order.id = :id', { id }).getOne();

    if (!order) {
      throw new BadRequestException('해당 주문건은 존재하지 않습니다.');
    }

    const operationUser = await this.userRepository.findOne({
      where: {
        id: operationUserId,
      },
    });

    if (!operationUser) {
      throw new BadRequestException('존재하지 않는 유저입니다.');
    }

    if (operationUser.authority !== IUserAuthority.OPERATION_ADMIN) {
      throw new BadRequestException('운영 담당자 유저가 아닙니다.');
    }

    order.operationUserId = operationUserId;
    // 운영 담당자 재할당은 의도적 변경이므로 스냅샷도 새 담당자명으로 갱신
    order.snapshotOperationPersonName = operationUser.personName;

    await this.orderRepository.save(order);
    return;
  }

  /** 엑셀 다운로드 기간 상한 가드 (최대 N년). 범위 미지정 시 통과(스트리밍이 메모리 보호). 초과 시 400. */
  private assertExcelExportRangeWithinYears(startAt?: string, endAt?: string, maxYears = 3): void {
    if (!startAt || !endAt) return;
    const start = new Date(startAt);
    const end = new Date(endAt);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return;
    const limit = new Date(start);
    limit.setFullYear(limit.getFullYear() + maxYears);
    if (end > limit) {
      throw new BadRequestException(`엑셀 다운로드 기간은 최대 ${maxYears}년까지 가능합니다.`);
    }
  }

  async excelDownload(
    user: ILoginUserInfo,
    getBody: OrderExcelDownloadReqBodyDto,
    meta: { ipAddress: string; userAgent: string },
  ) {
    const startTime = Date.now();
    const { section, password, downloadReason, startAt, endAt } = getBody;

    // 비밀번호 검증
    await this.activityLogService.verifyPassword(user.id, password);

    // 기간 상한 가드 (최대 3년) — 폭탄 다운로드 입구 차단
    this.assertExcelExportRangeWithinYears(startAt, endAt);

    const now = new Date();
    const nowString = format(now, 'yyyyMMdd');
    let orderType = '';

    if (section === IOrderSection.ORDER) {
      orderType = '주문';
    }

    if (section === IOrderSection.SHIPPING) {
      orderType = '발송';
    }

    const queryBuilder = await this.buildOrderListQuery(user, getBody);

    // 스트리밍(정산 패턴): 조건에 맞는 order.id 만 경량 수집 → 500건 청크 재조회 → 행별 commit (메모리 평탄)
    const idRows = await queryBuilder.clone().select('order.id', 'id').distinct(true).getRawMany();
    const ids = idRows.map((r) => Number(r.id));

    const fileName = `${orderType}_리스트_${nowString}.xlsx`;
    const filePath = createExportTempPath('xlsx');
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filePath });
    const sheet = workbook.addWorksheet(`sheet1`);

    sheet.columns = [
      { header: '번호', key: 'id', width: 10 },
      { header: '등록일', key: 'registerAt', width: 32 },
      { header: '고객사', key: 'userBusinessName', width: 20 },
      { header: '담당자', key: 'userPersonName', width: 20 },
      { header: '이벤트명', key: 'eventName', width: 20 },
      { header: '상품명', key: 'productName', width: 32 },
      { header: '발송수량', key: 'totalAmount', width: 32 },
      { header: '발송금액', key: 'sendAmount', width: 32 },
      { header: '정산금액', key: 'settleAmount', width: 40 },
      { header: '진행상태', key: 'status', width: 40 },
      { header: '발송시간', key: 'sendRequestAt', width: 40 },
    ];

    const getActualSendAt = (actualSendAt: Date | null) => {
      if (actualSendAt) {
        return dayjs(actualSendAt).format('YYYY/MM/DD HH:mm:ss');
      }
      return '-';
    };

    let id = 1;
    let recordCount = 0;
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunkIds = ids.slice(i, i + CHUNK);
      // 청크 재조회는 queryBuilder(orderBy id DESC) clone 이라 정렬 보존
      const chunkList = await queryBuilder.clone().andWhere('order.id IN (:...chunkIds)', { chunkIds }).getMany();
      for (const order of chunkList) {
        let totalAmount = 0;
        let productName = '';
        let actualSendAt: Date | null = null;

        if (order.orderProductMappings && order.orderProductMappings.length > 0) {
          totalAmount = order.orderProductMappings.reduce((acc, cur) => {
            return acc + cur.amount;
          }, 0);
          const firstProduct = order.orderProductMappings[0].product;
          productName = firstProduct ? firstProduct.name : '(삭제된 상품)';
          const orderProductMappingsLength = order.orderProductMappings.length;
          if (orderProductMappingsLength - 1 > 0) {
            productName += `외 ${orderProductMappingsLength - 1}건`;
          }

          // 실제 발송 시간 추출 (첫 번째 유효한 값 사용)
          for (const mapping of order.orderProductMappings) {
            if (mapping.orderDeliveries) {
              for (const delivery of mapping.orderDeliveries) {
                if (delivery.actualSendAt) {
                  actualSendAt = delivery.actualSendAt;
                  break;
                }
              }
            }
            if (actualSendAt) break;
          }
        }

        // 엑셀 출력: 주문 시점 스냅샷 우선, NULL이면 clientUser ?? user FK로 fallback
        const billing = readBillingView(order);

        sheet
          .addRow({
            id: id,
            registerAt: format(order.registerAt, 'yyyy-MM-dd HH:mm'),
            userBusinessName: billing.businessName,
            userPersonName: billing.personName,
            eventName: order.eventName,
            productName: productName,
            totalAmount: totalAmount,
            sendAmount: order.sendAmount,
            settleAmount: order.settleAmount,
            status: OrderStatusExcelMapping(order.status),
            sendRequestAt: getActualSendAt(actualSendAt),
          })
          .commit();
        id++;
        recordCount++;
      }
    }

    await sheet.commit();
    await workbook.commit();

    // 성공 로그 저장
    const responseTime = Date.now() - startTime;
    const requestParams = Object.fromEntries(Object.entries(getBody).filter(([key]) => key !== 'password'));

    await this.activityLogService.createLog({
      userId: user.id,
      userEmail: user.email,
      method: 'POST',
      requestUrl: '/order/excel-download',
      actionType: 'EXCEL_DOWNLOAD',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      statusCode: 200,
      result: ActivityLogResult.SUCCESS,
      responseTime,
      downloadReason,
      recordCount,
      requestParams,
      errorMessage: undefined,
    });

    return { fileName, filePath };
  }

  async getMyOrderHistory(user: ILoginUserInfo): Promise<OrderGetMyOrderHistoryResDto> {
    // 1. 최근 7일 범위 설정 (7일 전 00:00:00부터)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    // 2. 상태·타입 배열 enum 값 참조
    const statuses = Object.values(IOrderStatus).filter((s) => s !== IOrderStatus.DELIVERY_CANCEL);
    const types = Object.values(IOrderType);

    // 3. 상태·타입 총합 CASE 절 생성
    const selectExpressions: string[] = statuses.flatMap((status) => {
      const byType = types.map(
        (type) =>
          `SUM(CASE WHEN o.status='${status}' AND o.type='${type}' THEN 1 ELSE 0 END)
       AS "${status.toLowerCase()}${type.charAt(0) + type.slice(1).toLowerCase()}Count"`,
      );
      const total = `SUM(CASE WHEN o.status='${status}' THEN 1 ELSE 0 END)
       AS "${status.toLowerCase()}TotalCount"`;

      return [...byType, total];
    });

    // 4. 쿼리 빌더로 raw 데이터 조회
    const queryBuilder = this.orderRepository
      .createQueryBuilder('o')
      .select(selectExpressions)
      .where('o.registerAt >= :from', { from: sevenDaysAgo.toISOString() })
      .andWhere('o.status IN (:...statuses)', { statuses })
      .andWhere('o.type IN (:...types)', { types });

    // 5. 권한에 따른 조회 제약
    switch (user.authority as IUserAuthority) {
      case IUserAuthority.SUPER_ADMIN:
        // 아무 제약 없이 전체 조회
        break;

      case IUserAuthority.OPERATION_ADMIN:
        // 본인 주문 OR 본인이 담당한 주문
        queryBuilder.andWhere('(o.userId = :uid OR o.operationUserId = :uid)', { uid: user.id });
        break;

      case IUserAuthority.CORPORATE_ADMIN:
      default:
        // 본인 주문 + 본인이 고객으로 지정된 대행발송 건
        queryBuilder.andWhere('(o.userId = :uid OR (o.clientUserId = :uid AND o.apiAppId IS NULL))', { uid: user.id });
        break;
    }

    // 6. raw 데이터를 숫자형으로 변환
    const raw = await queryBuilder.getRawOne<Record<string, string>>();
    const numeric: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw ?? {})) {
      numeric[k] = Number.parseInt(v, 10) || 0;
    }

    // 7. OrderGetMyOrderHistoryResDto 객체로 변환
    return Object.assign(new OrderGetMyOrderHistoryResDto(), numeric);
  }

  /**
   * 주문상품의 쿠폰 유효기간(만료시각) 계산.
   * 우선순위: 발송완료(저장된 expireAt) > 예약발송(sendRequestAt 기준) > 즉시발송(현재시각 기준).
   * 일수는 resolveExpireDays(galaxiaDuration > product.expireDay ± validityStartsNextDay).
   */
  private resolveOrderExpireAt(
    orderProductMapping: OrderProductMappingEntity,
    firstDeliveryExpireAt?: Date | null,
  ): Date | null {
    if (firstDeliveryExpireAt) return firstDeliveryExpireAt;

    const expireDays = resolveExpireDays(
      orderProductMapping.galaxiaDuration ?? orderProductMapping.product?.galaxiaDuration,
      orderProductMapping.product?.expireDay ?? 0,
      orderProductMapping.product?.partnerCompany?.validityStartsNextDay,
    );
    if (!expireDays) return null;

    const baseDate = orderProductMapping.sendType === 'IMMEDIATE' ? dayjs() : dayjs(orderProductMapping.sendRequestAt);
    return baseDate.tz('Asia/Seoul').add(expireDays, 'day').toDate();
  }

  async testDelivery(user: ILoginUserInfo, getBody: OrderTestDeliveryReqDto) {
    const { orderId, orderProductMappingId, deliveryTarget } = getBody;

    await this.assertOrderInViewScope(user, orderId);

    // 최대 횟수 (상품별 2회). 운영관리자/최고관리자는 제한 없음.
    const maxLimitCount = 2;
    const barCode = '999999';
    const canBypassTestDeliveryLimit =
      user.authority === IUserAuthority.SUPER_ADMIN || user.authority === IUserAuthority.OPERATION_ADMIN;

    const orderProductMapping = await this.findOrderProductMappingInViewScope(user, orderProductMappingId, [
      'product',
      'product.brand',
      'product.partnerCompany',
    ]);

    if (!orderProductMapping) {
      throw new BadRequestException('해당 주문-상품이 존재하지 않습니다.');
    }

    if (orderProductMapping.orderId !== orderId) {
      throw new BadRequestException('주문 정보와 상품 정보가 일치하지 않습니다.');
    }

    const testDeliveryAllowedStatuses = [
      IOrderStatus.TEMP,
      IOrderStatus.DELIVERY_REQUEST,
      IOrderStatus.REVIEW_COMPLETE,
      IOrderStatus.DELIVERY_CONFIRMED,
      IOrderStatus.DELIVERY_COMPLETE,
    ];
    if (!testDeliveryAllowedStatuses.includes(orderProductMapping.order.status)) {
      throw new BadRequestException('현재 상태의 주문은 테스트 발송할 수 없습니다.');
    }

    // 크래시로 남은 미발송 이력을 먼저 정리한다. 한도 선점 전에 수행해야 회수한 횟수를 이번 요청이 쓴다.
    // 정리는 부가 작업이라 실패해도 발송 요청 자체를 막지 않는다. 실패 시 트랜잭션이 통째로 롤백되므로
    // 이력·한도가 함께 원복되고, 이 요청은 잔류가 없던 것처럼 평소 경로로 진행한다.
    try {
      await this.discardStaleTestDeliveries(orderProductMappingId);
    } catch (error) {
      this.logger.error(
        `테스트 발송 잔류 정리 중 오류 (orderProductMappingId: ${orderProductMappingId})`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    // 한도 사전 확인. 실제 선점은 이미지 생성 이후 이력 INSERT 와 한 트랜잭션에서 수행한다.
    // 여기서 미리 막는 이유는 한도 초과가 확실한 요청에 쿠폰 이미지 생성(외부 I/O) 비용을 쓰지 않기 위해서다.
    // 이 확인만으로는 동시 요청을 막지 못한다(TOCTOU). 실제 차단은 선점 트랜잭션의 조건부 UPDATE 가 담당한다.
    //
    // 카운트는 반드시 다시 읽는다. 위 잔류 정리가 한도를 회수했을 수 있는데, 앞서 조회한 엔티티는
    // 정리 이전 값이라 회수분이 반영되지 않아 쓸 수 있는 요청을 막게 된다.
    if (!canBypassTestDeliveryLimit) {
      const current = await this.orderProductMappingRepository.findOne({
        where: { id: orderProductMappingId },
        select: { id: true, testDeliveryCount: true },
      });
      // 매핑이 이미 사라졌으면(저장으로 재생성) 한도 초과가 아니라 매핑 소실로 안내한다.
      if (!current) {
        throw new BadRequestException('주문이 저장되어 테스트 발송이 취소되었습니다. 다시 시도해주세요.');
      }
      if (current.testDeliveryCount >= maxLimitCount) {
        throw new BadRequestException('테스트발송은 상품 행당 최대 2회입니다.');
      }
    }

    // 선점 이후의 모든 준비 단계(이미지 생성·이력 저장)와 발송을 한 번에 보상 범위로 묶는다.
    // 준비 단계도 외부 I/O 라 실패할 수 있고, 그때 보상하지 않으면 발송 없이 한도만 소진된다.
    let testOrderDeliveryId: number | null = null;
    let isSent = false;
    // 잔류 정리가 이미 이력·한도를 회수한 경우. 보상을 중복 적용하지 않기 위해 구분한다.
    let isStaleClaim = false;
    // 선점 트랜잭션이 실제로 커밋됐는지. 커밋 전 실패(이미지 생성·매핑 소실)는 보상 대상이 아니다.
    let hasClaimedLimit = false;
    try {
      const firstDelivery = await this.orderDeliveryRepository.findOne({
        where: { orderProductMappingId },
        order: { id: 'ASC' },
      });
      const expireAt = this.resolveOrderExpireAt(orderProductMapping, firstDelivery?.expireAt);
      const expireDate = expireAt ? dayjs(expireAt).tz('Asia/Seoul').format('YYYY. MM. DD') : null;

      const deliveryMethod = orderProductMapping.sendMethod!;
      const encryptedDeliveryTarget = this.cryptoCipher.encryptDeliveryTarget(
        PhoneUtil.normalizeDeliveryTarget(deliveryTarget),
      );

      // 쿠폰이미지 만들기
      const { path: imagePath } = await DeliveryCreateCouponImage(
        orderProductMapping.product.imagePath,
        orderProductMapping.product.name,
        barCode,
        orderProductMapping.product.brand!.nameKorean,
        expireDate,
        orderProductMapping.topImagePath,
        orderProductMapping.midImagePath,
        orderProductMapping.product.type,
      );

      // 한도 선점과 이력 INSERT 를 한 트랜잭션으로 묶는다. 선점만 커밋되고 이력이 없는 상태가 생기면
      // 그 선점은 회수할 근거가 사라진다(잔류 정리는 이력 행을 기준으로 회수한다). 둘을 함께 커밋해
      // "선점했으면 반드시 이력이 있다"를 보장하고, 이후 실패는 이력 기준으로 회수 가능하게 만든다.
      //
      // 매핑 행에 잠금을 걸어 updateTemp 의 잠금 읽기(재생성)와 직렬화한다. 이미지 생성(외부 I/O)은
      // 이미 끝났으므로 이 트랜잭션은 짧고, 외부 I/O 를 트랜잭션 안에 넣지 않는다.
      const claimed = await this.claimTestDeliveryLimitWithHistory({
        orderProductMappingId,
        canBypassTestDeliveryLimit,
        maxLimitCount,
        deliveryMethod,
        encryptedDeliveryTarget,
        imagePath,
        expireAt,
        barCode,
      });
      testOrderDeliveryId = claimed.testOrderDeliveryId;
      // 여기까지 왔으면 선점(+1)과 이력이 함께 커밋됐다. 이후 실패는 보상 대상이다.
      hasClaimedLimit = true;

      const orderDelivery = new OrderDeliveryEntity();
      orderDelivery.deliveryMethod = deliveryMethod;
      orderDelivery.orderProductMappingId = orderProductMapping.id;
      orderDelivery.deliveryTarget = encryptedDeliveryTarget;
      orderDelivery.barCode = barCode;
      orderDelivery.personalCode = barCode;
      orderDelivery.orderProductMapping = orderProductMapping;
      orderDelivery.imagePath = imagePath;
      orderDelivery.expireAt = expireAt;

      // 발송 직전 WAIT 로 전환한다. 크래시로 잔류했을 때 TEMP(발송 전)와 WAIT(발송 여부 불명)를
      // 구분해야 잔류 정리가 미발송 건만 골라 되돌릴 수 있다.
      //
      // 이 전환은 발송 권한 선점도 겸한다. 이 요청이 오래 정지된 사이 다른 인스턴스의 잔류 정리가
      // 이 이력을 이미 지웠을 수 있는데(TEMP + grace 경과), 그대로 발송하면 이력 없는 물리 발송이 된다.
      // TEMP·미삭제인 행만 전환하고 affected 로 확인해, 내 이력이 아니면 발송 전에 중단한다.
      const sendClaim = await this.testOrderDeliveryRepository
        .createQueryBuilder()
        .update()
        .set({ status: IOrderDeliveryStatus.WAIT })
        .where('id = :id', { id: testOrderDeliveryId })
        .andWhere('status = :temp', { temp: IOrderDeliveryStatus.TEMP })
        .andWhere('deleted_at IS NULL')
        // 승계로 매핑이 바뀌었으면 발송 payload 가 낡은 설정이라 중단한다.
        .andWhere('order_product_mapping_id = :orderProductMappingId', { orderProductMappingId })
        .execute();
      if ((sendClaim.affected ?? 0) !== 1) {
        // 0행 원인이 둘이라 구분한다. 이력이 살아있으면 승계로 매핑만 바뀐 것이라 선점이 새 행에
        // 남아 있어 보상해야 하고, 이력이 없으면 잔류 정리가 한도까지 회수한 뒤라 보상하면 이중 차감이다.
        const survived = await this.testOrderDeliveryRepository.findOne({
          where: { id: testOrderDeliveryId },
          select: { id: true },
        });
        isStaleClaim = survived === null;
        this.logger.error(
          `테스트 발송 WAIT 전환이 0행 (testOrderDeliveryId: ${testOrderDeliveryId}) — ${
            isStaleClaim ? '잔류 정리로 이력이 이미 회수됨' : '저장으로 매핑이 재생성됨'
          }. 발송하지 않고 중단`,
        );
        throw new BadRequestException('테스트 발송 요청이 만료되었습니다. 다시 시도해주세요.');
      }

      // 전송 (TX 밖 — testOrderDeliveryId 로 테스트 발송임을 전달하여 PIN 재발급 스킵).
      const isSuccess = await this.deliveryBatchService.oneSend(orderDelivery, false, testOrderDeliveryId);
      if (!isSuccess) {
        throw new BadRequestException('테스트 발송에 실패했습니다. 수신자 정보를 확인해주세요.');
      }

      // 발송 성공 후 확정. WAIT 인 행만 전환한다.
      // confirmed_at 을 함께 각인해 "발송 성공이 확인된 건"을 표시한다. 이 기능 이전 legacy 행은
      // 발송 전에 COMPLETE 로 저장돼 실패 건이 섞여 있으므로, status 만으로는 성공 이력을 가려낼 수 없다.
      isSent = true;
      const confirm = await this.testOrderDeliveryRepository
        .createQueryBuilder()
        .update()
        .set({ status: IOrderDeliveryStatus.COMPLETE, confirmedAt: () => 'NOW()' })
        .where('id = :id', { id: testOrderDeliveryId })
        .andWhere('status = :wait', { wait: IOrderDeliveryStatus.WAIT })
        .execute();
      if ((confirm.affected ?? 0) === 0) {
        this.logger.error(
          `테스트 발송 확정 UPDATE 가 0행 (testOrderDeliveryId: ${testOrderDeliveryId}) — 이미 발송된 건이 TEMP 로 잔류`,
        );
      }
    } catch (error) {
      // 이미 발송된 건은 되돌리지 않는다. 이력 삭제·한도 보상 시 다음 요청이 다시 발송해 중복이 된다.
      if (isSent) {
        this.logger.error(
          `테스트 발송 확정 실패 (testOrderDeliveryId: ${testOrderDeliveryId}) — 발송은 완료됨. 이력 TEMP 잔류, 한도 보상 안 함`,
          error instanceof Error ? error.stack : String(error),
        );
        throw error;
      }
      // 선점 트랜잭션이 커밋되지 않았으면 되돌릴 선점 자체가 없다(이미지 생성 실패, 매핑 소실, 한도 초과).
      // 관리자 발송은 한도를 선점하지 않으므로 보상 차감도 하지 않는다(하면 기업관리자 한도를 깎는다).
      // 잔류 정리가 이미 회수한 건(isStaleClaim)도 같은 이유로 보상 대상에서 제외한다.
      const shouldCompensate = hasClaimedLimit && !canBypassTestDeliveryLimit && !isStaleClaim;
      try {
        await this.rollbackTestDelivery(testOrderDeliveryId, orderProductMappingId, shouldCompensate);
      } catch (rollbackError) {
        // 보상 실패가 원 발송 실패 사유를 덮지 않도록 로그만 남긴다.
        // 보상은 한 트랜잭션이라 부분 반영은 없지만, 선점(+1)은 이 TX 밖에서 이미 커밋됐으므로 남는다.
        // 이후 회수 여부는 이력 상태에 달렸다.
        // - TEMP 로 남은 경우(WAIT 전환 전 실패): 잔류 정리가 삭제하며 한도를 회수한다.
        // - WAIT 로 남은 경우(발송 시도 후 실패): 발송 여부 불명이라 자동 회수하지 않는다.
        //   ops_escalated_at 경보로 운영이 확인한다.
        // - 이력 자체가 없는 경우(testOrderDeliveryId === null): 회수 근거가 없어 자동 복구되지 않는다.
        //   아래 로그가 유일한 추적 수단이다.
        this.logger.error(
          `테스트 발송 보상 처리 중 오류 (testOrderDeliveryId: ${testOrderDeliveryId}, orderProductMappingId: ${orderProductMappingId})`,
          rollbackError instanceof Error ? rollbackError.stack : String(rollbackError),
        );
      }
      throw error;
    }
  }

  /**
   * 테스트 발송 한도 선점(+1)과 이력 INSERT 를 한 트랜잭션으로 처리한다.
   *
   * 선점만 커밋되고 이력이 없는 상태를 만들지 않는 것이 목적이다. 잔류 정리(discardStaleTestDeliveries)는
   * 이력 행을 기준으로 한도를 회수하므로, 이력 없는 선점은 회수 근거가 없어 영구 누수가 된다.
   * 둘을 함께 커밋하면 이후 어떤 실패든 이력 행을 통해 회수할 수 있다.
   *
   * 매핑 행을 먼저 잠가 updateTemp 의 잠금 읽기와 직렬화한다. updateTemp 가 먼저 잠갔다면 재생성이
   * 끝난 뒤 이 잠금이 잡히고, 그때 옛 id 는 사라져 있으므로 매핑 소실로 판정된다. 반대 순서면
   * updateTemp 가 이 트랜잭션의 커밋된 +1 을 승계하므로 선점이 유실되지 않는다.
   *
   * 락 순서는 order_product_mapping -> test_order_delivery 로, updateTemp 와 같은 방향이다.
   * 외부 I/O(쿠폰 이미지 생성)는 호출 전에 끝나므로 이 트랜잭션 안에 들어오지 않는다.
   */
  @Transactional({ propagation: Propagation.REQUIRES_NEW })
  private async claimTestDeliveryLimitWithHistory(params: {
    orderProductMappingId: number;
    canBypassTestDeliveryLimit: boolean;
    maxLimitCount: number;
    deliveryMethod: IOrderSendMethod;
    encryptedDeliveryTarget: string;
    imagePath: string;
    expireAt: Date | null;
    barCode: string;
  }): Promise<{ testOrderDeliveryId: number }> {
    const {
      orderProductMappingId,
      canBypassTestDeliveryLimit,
      maxLimitCount,
      deliveryMethod,
      encryptedDeliveryTarget,
      imagePath,
      expireAt,
      barCode,
    } = params;

    // 매핑 생존 확인 + 행 잠금. updateTemp 가 재생성했으면 이 id 는 없다.
    // 잠금을 먼저 잡으므로, updateTemp 가 진행 중이면 재생성이 끝난 뒤에 이 조회가 수행된다.
    const aliveMapping = await this.orderProductMappingRepository
      .createQueryBuilder('orderProductMapping')
      .setLock('pessimistic_write')
      .where('orderProductMapping.id = :id', { id: orderProductMappingId })
      .getOne();
    if (!aliveMapping) {
      throw new BadRequestException('주문이 저장되어 테스트 발송이 취소되었습니다. 다시 시도해주세요.');
    }
    // 잠금 대기 중 매핑이 삭제(승계 없는 라인 삭제)됐을 수도 있다. 위 조회가 그 경우를 잡는다.
    // 아래 선점 UPDATE 의 affected=0 은 이제 한도 초과만 의미한다.

    // 한도 용량 원자 선점: count < 2 인 경우에만 +1. affected=0 이면 한도 초과(동시 요청 포함)로 차단한다.
    // 운영관리자/최고관리자는 무제한이라 카운트를 아예 건드리지 않는다. 여기서 +1 하면 관리자 발송이
    // 기업관리자 한도(상품당 2회)를 대신 소진해 "기업관리자만 2회 제한" 정책과 어긋난다.
    if (!canBypassTestDeliveryLimit) {
      const claim = await this.orderProductMappingRepository
        .createQueryBuilder()
        .update()
        .set({ testDeliveryCount: () => 'test_delivery_count + 1' })
        .where('id = :id', { id: orderProductMappingId })
        .andWhere('test_delivery_count < :maxLimitCount', { maxLimitCount })
        .execute();
      if ((claim.affected ?? 0) === 0) {
        throw new BadRequestException('테스트발송은 상품 행당 최대 2회입니다.');
      }
    }

    // test_order_delivery 저장 (oneSend에서 테스트 발송 여부를 판단하여 PIN 재발급 스킵)
    // 발송 전에는 TEMP 로 저장한다. COMPLETE 를 미리 넣으면 발송 중/실패 건이 성공 이력으로 노출된다.
    const testOrderDelivery = new TestOrderDeliveryEntity();
    testOrderDelivery.status = IOrderDeliveryStatus.TEMP;
    testOrderDelivery.orderProductMappingId = orderProductMappingId;
    testOrderDelivery.deliveryMethod = deliveryMethod;
    testOrderDelivery.deliveryTarget = encryptedDeliveryTarget;
    testOrderDelivery.imagePath = imagePath;
    testOrderDelivery.sendRequestAt = new Date();
    testOrderDelivery.expireAt = expireAt;
    testOrderDelivery.barCode = barCode;
    testOrderDelivery.personalCode = barCode;
    // 이 건이 한도를 선점했는지 남긴다. 관리자 발송(false)은 카운트를 올리지 않았으므로
    // 잔류 정리 시에도 회수 대상이 아니다. 행만 보고 회수 여부를 판단할 수 있어야 한다.
    testOrderDelivery.limitClaimed = !canBypassTestDeliveryLimit;
    const saved = await this.testOrderDeliveryRepository.save(testOrderDelivery);

    return { testOrderDeliveryId: saved.id };
  }

  /**
   * 크래시나 확정 실패로 rollbackTestDelivery 가 실행되지 못해 남은 이력을 정리한다.
   *
   * TEMP 는 oneSend 호출 전에 죽은 경우라 확실한 미발송이다. 이력을 지우고 선점한 한도를 회수한다.
   * 단, 한도 회수는 선점한 건(limit_claimed = 1)만 대상이다. 관리자 발송은 카운트를 올리지 않았으므로
   * 이력만 지우고 한도는 건드리지 않는다.
   * WAIT 은 발송됐을 수 있어 provider 도달 여부를 알 수 없다. 지우면 재발송으로 중복이 될 수 있어
   * 그대로 두고 한도도 소진 상태로 유지한다. 대신 화면에 안 보이면서 횟수만 소진된 상태라
   * 운영이 인지할 수 있도록 1회 경보·마킹한다(자동 확정은 미발송 건을 성공으로 만들 수 있어 하지 않는다).
   *
   * 진행 중인 정상 흐름을 잔류로 오인하지 않도록 grace 를 둔다.
   *
   * 이력 삭제와 한도 회수는 한 트랜잭션이어야 한다. 둘이 갈라지면 이력만 지워지고 한도는 남아,
   * 원 요청이 WAIT 전환 0행을 보고 "이미 회수됐다"고 판단해 보상을 생략하면서 한도가 영구 누수된다.
   * 발송 전에만 호출하므로(외부 I/O 앞) REQUIRES_NEW 로 열어도 발송 구간을 TX 안에 넣지 않는다.
   */
  @Transactional({ propagation: Propagation.REQUIRES_NEW })
  private async discardStaleTestDeliveries(orderProductMappingId: number): Promise<void> {
    const graceSeconds = 600;

    // 이력에 손대기 전에 매핑 행을 먼저 잠근다. 락 순서를 order_product_mapping -> test_order_delivery 로
    // updateTemp 와 맞춰야 데드락 사이클이 생기지 않는다.
    await this.orderProductMappingRepository
      .createQueryBuilder('orderProductMapping')
      .setLock('pessimistic_write')
      .where('orderProductMapping.id = :id', { id: orderProductMappingId })
      .getOne();

    // 한도를 선점한 건(limit_claimed = 1)만 대상으로 한다. affected 를 그대로 회수량으로 쓰므로
    // 관리자 발송(선점 없음)이 섞이면 올리지도 않은 한도를 깎게 된다.
    const stale = await this.testOrderDeliveryRepository
      .createQueryBuilder()
      .softDelete()
      .where('order_product_mapping_id = :orderProductMappingId', { orderProductMappingId })
      .andWhere('status = :temp', { temp: IOrderDeliveryStatus.TEMP })
      .andWhere('deleted_at IS NULL')
      .andWhere('limit_claimed = 1')
      .andWhere(`created_at < NOW(6) - INTERVAL ${graceSeconds} SECOND`)
      .execute();

    const discarded = stale.affected ?? 0;
    if (discarded > 0) {
      // 발송되지 않은 건이므로 선점됐던 한도를 회수한다. 0 미만으로 내려가지 않도록 조건부 차감.
      await this.orderProductMappingRepository
        .createQueryBuilder()
        .update()
        .set({ testDeliveryCount: () => `GREATEST(test_delivery_count - ${discarded}, 0)` })
        .where('id = :id', { id: orderProductMappingId })
        .execute();

      this.logger.warn(
        `테스트 발송 미발송 잔류 ${discarded}건 정리·한도 회수 (orderProductMappingId: ${orderProductMappingId})`,
      );
    }

    // 선점하지 않은(관리자) TEMP 잔류도 화면에 남지 않도록 정리한다. 한도는 올린 적이 없어 회수하지 않는다.
    const discardedUnclaimed = await this.testOrderDeliveryRepository
      .createQueryBuilder()
      .softDelete()
      .where('order_product_mapping_id = :orderProductMappingId', { orderProductMappingId })
      .andWhere('status = :temp', { temp: IOrderDeliveryStatus.TEMP })
      .andWhere('deleted_at IS NULL')
      .andWhere('limit_claimed = 0')
      .andWhere(`created_at < NOW(6) - INTERVAL ${graceSeconds} SECOND`)
      .execute();

    if ((discardedUnclaimed.affected ?? 0) > 0) {
      this.logger.warn(
        `테스트 발송 미발송 잔류(관리자, 한도 미선점) ${discardedUnclaimed.affected}건 정리 (orderProductMappingId: ${orderProductMappingId})`,
      );
    }

    // 발송 여부 불명(WAIT) 잔류는 미경보 건만 1회 마킹한다. ops_escalated_at 이 중복 경보를 막는다.
    const escalated = await this.testOrderDeliveryRepository
      .createQueryBuilder()
      .update()
      .set({ opsEscalatedAt: () => 'NOW()' })
      .where('order_product_mapping_id = :orderProductMappingId', { orderProductMappingId })
      .andWhere('status = :wait', { wait: IOrderDeliveryStatus.WAIT })
      .andWhere('deleted_at IS NULL')
      .andWhere('ops_escalated_at IS NULL')
      .andWhere(`created_at < NOW(6) - INTERVAL ${graceSeconds} SECOND`)
      .execute();

    if ((escalated.affected ?? 0) > 0) {
      this.logger.error(
        `테스트 발송 여부 불명 ${escalated.affected}건 잔류 — 운영 확인 필요 (orderProductMappingId: ${orderProductMappingId})`,
      );
    }
  }

  // 테스트 발송 실패 시 저장한 이력 제거 + 선점한 한도 보상 차감(-1).
  // 발송 전에 한도를 선점(+1)했으므로 이후 단계가 실패하면 되돌린다.
  // testOrderDeliveryId 가 null 이면 이력 저장 전(이미지 생성 등)에 실패한 경우라 한도 보상만 수행한다.
  // limitClaimed 가 false 면 관리자 발송이라 선점 자체가 없었으므로 이력만 제거한다.
  //
  // 이력 삭제와 한도 보상은 한 트랜잭션이어야 한다. 둘이 갈라지면
  // - 삭제만 성공: 이력이 없어 잔류 정리도 회수하지 못해 한도가 영구 소진된다.
  // - 보상만 성공: TEMP 행이 남아 잔류 정리가 같은 건을 다시 -1 해 2회 제한을 우회한다.
  // 발송 실패 직후(외부 I/O 종료 후)에만 호출하므로 REQUIRES_NEW 로 열어도 발송 구간을 TX 안에 넣지 않는다.
  //
  // 이 TX 가 통째로 실패하면 선점(+1)은 TX 밖에서 이미 커밋됐으므로 남는다. 이때 자동 회수는
  // 이력이 TEMP 로 남은 경우에만 이뤄진다. WAIT(발송 시도 후)은 도달 여부 불명이라 경보만 하고,
  // 이력이 없으면(testOrderDeliveryId === null) 회수 근거가 없어 호출부 로그가 유일한 추적 수단이다.
  @Transactional({ propagation: Propagation.REQUIRES_NEW })
  private async rollbackTestDelivery(
    testOrderDeliveryId: number | null,
    orderProductMappingId: number,
    limitClaimed: boolean,
  ): Promise<void> {
    // 이력에 손대기 전에 매핑 행을 먼저 잠근다. 락 순서를 order_product_mapping -> test_order_delivery 로
    // updateTemp 와 맞춰야 데드락 사이클이 생기지 않는다(이력 먼저 잠그면 서로 반대 방향이 된다).
    // 매핑이 이미 사라졌으면 잠글 대상이 없고, 그때는 아래 보상 대상 재조회가 승계된 새 매핑을 찾는다.
    await this.orderProductMappingRepository
      .createQueryBuilder('orderProductMapping')
      .setLock('pessimistic_write')
      .where('orderProductMapping.id = :id', { id: orderProductMappingId })
      .getOne();

    // 살아있는 행을 이 요청이 실제로 지웠을 때만 보상한다.
    // 발송 실패를 처리하는 사이 다른 인스턴스의 잔류 정리가 같은 행을 지우며 한도까지 회수했을 수 있는데,
    // 여기서 또 -1 하면 그 회수분과 겹쳐 앞선 성공 건의 선점까지 깎여 2회 제한을 넘겨 발송할 수 있다.
    if (testOrderDeliveryId !== null) {
      const removed = await this.testOrderDeliveryRepository
        .createQueryBuilder()
        .softDelete()
        .where('id = :id', { id: testOrderDeliveryId })
        .andWhere('deleted_at IS NULL')
        .execute();

      // 선점하지 않았으면(관리자 무제한 경로) 되돌릴 것도 없다. 여기서 차감하면 남의 한도를 깎는다.
      if (!limitClaimed) {
        return;
      }

      if ((removed.affected ?? 0) !== 1) {
        this.logger.warn(
          `테스트 발송 이력이 이미 정리됨 (testOrderDeliveryId: ${testOrderDeliveryId}) — 한도 회수는 정리 쪽에서 수행돼 보상 생략`,
        );
        return;
      }
    } else if (!limitClaimed) {
      return;
    }

    // 보상 대상은 인자로 받은 id 가 아니라 이력 행이 현재 가리키는 매핑 id 다.
    // updateTemp 가 매핑을 재생성했다면 승계 UPDATE 가 이력의 orderProductMappingId 를 새 id 로 옮겨 놨고,
    // 선점분(+1)도 그 새 행에 승계돼 있다. 인자(옛 id)로 차감하면 affected=0 이 되어 한도가 영구 누수된다.
    let compensateTargetId = orderProductMappingId;
    if (testOrderDeliveryId !== null) {
      const history = await this.testOrderDeliveryRepository.findOne({
        where: { id: testOrderDeliveryId },
        withDeleted: true,
        select: { id: true, orderProductMappingId: true },
      });
      if (history && history.orderProductMappingId !== orderProductMappingId) {
        this.logger.warn(
          `테스트 발송 보상 대상이 승계된 매핑으로 변경됨 (testOrderDeliveryId: ${testOrderDeliveryId}, ${orderProductMappingId} -> ${history.orderProductMappingId})`,
        );
        compensateTargetId = history.orderProductMappingId;
      }
    }

    // 발송 전 +1 한 선점을 되돌린다. 0 미만으로 내려가지 않도록 조건부 차감.
    const compensated = await this.orderProductMappingRepository
      .createQueryBuilder()
      .update()
      .set({ testDeliveryCount: () => 'test_delivery_count - 1' })
      .where('id = :id', { id: compensateTargetId })
      .andWhere('test_delivery_count > 0')
      .execute();

    // 여기까지 왔는데 0행이면 매핑이 승계 없이 사라진 경우다(라인 삭제 등). 승계처가 없어 회수할 대상이 없다.
    if ((compensated.affected ?? 0) === 0) {
      this.logger.warn(
        `테스트 발송 한도 보상 대상 없음 (orderProductMappingId: ${compensateTargetId}) — 매핑이 승계 없이 삭제된 것으로 보인다`,
      );
    }
  }

  /**
   * 주문 상세에 노출할 테스트 발송 이력을 orderProductMappingId 별로 모아 돌려준다.
   *
   * 발송 성공이 확인된 건만 노출한다. TEMP(발송 전)/WAIT(발송 여부 불명)/FAIL 은 제외하고,
   * confirmed_at 이 NULL 인 행도 제외한다. 이 기능 이전 구현은 oneSend 호출 전에 status=COMPLETE 로
   * 저장하고 실패해도 행을 지우지 않아, 기존 COMPLETE 행에는 실패 건이 섞여 있다. status 만으로 거르면
   * 과거 실패 발송이 배포 즉시 성공 이력으로 노출된다. 확정 시각이 찍힌 신규 흐름의 건만 신뢰한다.
   */
  private async loadTestDeliveryHistories(
    orderProductMappingIds: number[],
  ): Promise<Map<number, OrderTestDeliveryHistoryDto[]>> {
    const historyMap = new Map<number, OrderTestDeliveryHistoryDto[]>();
    if (orderProductMappingIds.length === 0) {
      return historyMap;
    }

    const testDeliveryHistories = await this.testOrderDeliveryRepository.find({
      where: {
        orderProductMappingId: In(orderProductMappingIds),
        status: In([IOrderDeliveryStatus.COMPLETE, IOrderDeliveryStatus.COMPLETE_SMS]),
        confirmedAt: Not(IsNull()),
      },
      order: { id: 'ASC' },
    });

    // id ASC 로 조회되므로, 상품별 push 순서(배열 인덱스+1)가 곧 id ASC 순번이다.
    for (const history of testDeliveryHistories) {
      const histories = historyMap.get(history.orderProductMappingId) ?? [];
      histories.push({
        sequence: histories.length + 1,
        deliveryTarget: this.cryptoCipher.safeDecryptDeliveryTarget(history.deliveryTarget) ?? '',
        sendRequestAt: format(history.sendRequestAt, DateFormatStr),
      });
      historyMap.set(history.orderProductMappingId, histories);
    }

    return historyMap;
  }

  async getPreviousContent(
    user: ILoginUserInfo,
    getDto: OrderGetPreviousContentReqQueryDto,
  ): Promise<OrderGetPreviousContentResDto> {
    const { orderId, productId } = getDto;

    const response: OrderGetPreviousContentResDto = {
      sendTitle: null,
      sendContent: null,
    };

    let currentOrderQueryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoin('order.user', 'user')
      .withDeleted()
      .where('order.id = :id', { id: orderId })
      .andWhere('order.deletedAt IS NULL');

    const currentUser = await this.userRepository.findOne({
      where: { id: user.id },
      select: ['id', 'companyId', 'departmentId'],
    });
    const viewScope = await this.userViewScopeRepository.findOne({
      where: { userId: user.id },
    });
    currentOrderQueryBuilder = this.applyViewScopeFilter(currentOrderQueryBuilder, user, currentUser, viewScope);

    const order = await currentOrderQueryBuilder.getOne();

    if (!order) {
      return response;
    }

    const queryBuilder = this.orderProductMappingRepository
      .createQueryBuilder('orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .where('order.id != :id', { id: orderId })
      .andWhere('order.userId = :userId', { userId: user.id })
      .andWhere('order.status IN (:...statusList)', {
        statusList: [IOrderStatus.DELIVERY_REQUEST, IOrderStatus.DELIVERY_CONFIRMED, IOrderStatus.DELIVERY_COMPLETE],
      })
      .andWhere('order.type = :type', { type: order.type })
      .orderBy('orderProductMapping.id', 'DESC');

    if (productId) {
      queryBuilder.andWhere('orderProductMapping.productId = :productId', { productId });
    }

    const orderProductMapping = await queryBuilder.getOne();

    if (orderProductMapping) {
      response.sendTitle = orderProductMapping.sendTitle ?? '';
      response.sendContent = orderProductMapping.sendContent ?? '';
      return response;
    }

    return response;
  }

  /**
   * 독려문자 설정 수정 (발송관리용, 상품별)
   * @param orderProductMappingId order_product_mapping의 id
   */
  async updateEncourageDay(
    user: ILoginUserInfo,
    orderProductMappingId: number,
    getBody: OrderUpdateEncourageDayReqBodyDto,
  ): Promise<void> {
    const { encourageDay } = getBody;

    const orderProductMapping = await this.findOrderProductMappingInViewScope(user, orderProductMappingId);

    if (!orderProductMapping) {
      throw new BadRequestException('존재하지 않는 상품입니다.');
    }

    // 발송관리에서만 수정 가능 (주문완료 상태 이상)
    if (orderProductMapping.order.status === IOrderStatus.TEMP) {
      throw new BadRequestException('임시저장 상태에서는 독려문자를 설정할 수 없습니다.');
    }

    if (encourageDay === undefined) {
      throw new BadRequestException('독려일을 입력해주세요.');
    }

    // 독려문자 사용 설정 시 유효기간 검증
    if (encourageDay != null) {
      if (!Number.isInteger(encourageDay) || encourageDay < 1) {
        throw new BadRequestException('독려일은 1 이상의 정수여야 합니다.');
      }

      // 해당 상품의 배송 정보 중 가장 빠른 만료일 조회
      const orderDelivery = await this.orderDeliveryRepository
        .createQueryBuilder('orderDelivery')
        .where('orderDelivery.orderProductMappingId = :orderProductMappingId', { orderProductMappingId })
        .andWhere('orderDelivery.expireAt IS NOT NULL')
        .orderBy('orderDelivery.expireAt', 'ASC')
        .getOne();

      if (orderDelivery?.expireAt) {
        const now = new Date();
        const expireAt = new Date(orderDelivery.expireAt);
        const diffTime = expireAt.getTime() - now.getTime();
        const remainingDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        // 유효기간이 이미 지난 경우
        if (remainingDays <= 0) {
          throw new BadRequestException('유효기간이 만료되어 독려문자를 설정할 수 없습니다.');
        }

        // 독려일이 남은 유효기간보다 큰 경우
        if (encourageDay >= remainingDays) {
          throw new BadRequestException(`남은 유효기간(${remainingDays}일)보다 작은 값을 입력해주세요.`);
        }
      }
    }

    orderProductMapping.encourageDay = encourageDay;
    await this.orderProductMappingRepository.save(orderProductMapping);
  }

  /**
   * GALAXIA cpn 유효기간(duration) 설정 수정 (발송관리용, 상품별)
   * @param orderProductMappingId order_product_mapping의 id
   */
  async updateGalaxiaDuration(
    user: ILoginUserInfo,
    orderProductMappingId: number,
    getBody: OrderUpdateGalaxiaDurationReqBodyDto,
  ): Promise<void> {
    const { galaxiaDuration } = getBody;

    const orderProductMapping = await this.findOrderProductMappingInViewScope(user, orderProductMappingId, [
      'product',
      'product.partnerCompany',
    ]);

    if (!orderProductMapping) {
      throw new BadRequestException('존재하지 않는 상품입니다.');
    }

    // 임시저장 상태에서는 설정 불가
    if (orderProductMapping.order.status === IOrderStatus.TEMP) {
      throw new BadRequestException('임시저장 상태에서는 유효기간을 설정할 수 없습니다.');
    }

    // 발송 확정 이후에는 설정 불가 (API에 이미 전달된 duration 변경 방지)
    const blockedStatuses = [
      IOrderStatus.DELIVERY_CONFIRMED,
      IOrderStatus.DELIVERY_COMPLETE,
      IOrderStatus.DELIVERY_CANCEL,
    ];
    if (blockedStatuses.includes(orderProductMapping.order.status)) {
      throw new BadRequestException('발송 확정 이후에는 유효기간을 변경할 수 없습니다.');
    }

    // GALAXIA 상품만 설정 가능
    if (orderProductMapping.product.partnerCompany?.type !== 'GALAXIA') {
      throw new BadRequestException('GALAXIA 상품만 유효기간(duration)을 설정할 수 있습니다.');
    }

    // 백화점(dept) 상품 제외 (cpn만 지원)
    if (orderProductMapping.product.name.includes('(백화점)')) {
      throw new BadRequestException('백화점 상품권은 duration 설정을 지원하지 않습니다.');
    }

    // 범위 검증 (1~999 정수)
    if (galaxiaDuration !== null) {
      if (!Number.isInteger(galaxiaDuration) || galaxiaDuration < 1 || galaxiaDuration > 999) {
        throw new BadRequestException('유효기간은 1~999 사이의 정수여야 합니다.');
      }
    }

    orderProductMapping.galaxiaDuration = galaxiaDuration;
    await this.orderProductMappingRepository.save(orderProductMapping);
  }

  /**
   * 꼬리광고 설정 수정 (발송관리용, 상품별)
   * @param orderProductMappingId order_product_mapping의 id
   */
  async updateTailText(
    user: ILoginUserInfo,
    orderProductMappingId: number,
    getBody: OrderUpdateTailTextReqBodyDto,
  ): Promise<void> {
    const { sendTailText } = getBody;

    const orderProductMapping = await this.findOrderProductMappingInViewScope(user, orderProductMappingId);

    if (!orderProductMapping) {
      throw new BadRequestException('존재하지 않는 상품입니다.');
    }

    // 발송관리에서만 수정 가능 (주문완료 상태 이상)
    if (orderProductMapping.order.status === IOrderStatus.TEMP) {
      throw new BadRequestException('임시저장 상태에서는 꼬리광고를 설정할 수 없습니다.');
    }

    // 빈 문자열인 경우 null로 처리
    orderProductMapping.sendTailText = sendTailText?.trim() || null;
    await this.orderProductMappingRepository.save(orderProductMapping);
  }

  /**
   * 이메일 사용방법 수정 (발송관리용, 상품별)
   * @param orderProductMappingId order_product_mapping의 id
   */
  async updateUseEmailContent(
    user: ILoginUserInfo,
    orderProductMappingId: number,
    getBody: OrderUpdateUseEmailContentReqBodyDto,
  ): Promise<void> {
    const { useEmailContent } = getBody;

    const orderProductMapping = await this.findOrderProductMappingInViewScope(user, orderProductMappingId);

    if (!orderProductMapping) {
      throw new BadRequestException('존재하지 않는 상품입니다.');
    }

    // 발송관리에서만 수정 가능 (주문완료 상태 이상)
    if (orderProductMapping.order.status === IOrderStatus.TEMP) {
      throw new BadRequestException('임시저장 상태에서는 이메일 사용방법을 설정할 수 없습니다.');
    }

    orderProductMapping.useEmailContent = useEmailContent;
    await this.orderProductMappingRepository.save(orderProductMapping);
  }

  /**
   * 상품에 맞는 할인/할증 설정을 찾는 헬퍼 함수
   * - BULK(일괄): 구간 없이 해당 상품군/대분류 전체에 적용
   * - SECTION(구간): 상품 단가가 속하는 구간의 할인율을 전체 가격에 적용
   */
  // findMatchingDiscount는 user_discount/domain/discount.matcher.ts 공통 함수 사용

  /**
   * 서버측 파기확인서 발행 게이트.
   *
   * 목록 응답의 canIssueDestructionCertificate 는 UI 힌트이므로, 실제 발행 경로
   * (메일 발송 / PDF 발행 기록)에서 서버가 다시 판정한다.
   * 폐기후재발행 롤백으로 soft-delete 된 배송건에도 미파기 PII 가 남을 수 있어,
   * withDeleted 로 조회해 목록 게이트와 동일한 집합을 판정한다.
   */
  private async assertDestructionCertificateIssuable(orderId: number, user?: ILoginUserInfo): Promise<void> {
    const order = user
      ? await this.findReportOrderInViewScope(user, orderId, true)
      : await this.orderRepository.findOne({
          where: { id: orderId },
          relations: ['orderProductMappings', 'orderProductMappings.orderDeliveries'],
          withDeleted: true,
        });

    if (!order) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    const gate = resolveDestructionCertificateGate(order);
    if (!gate.canIssue) {
      throw new BadRequestException(destructionCertificateBlockMessage(gate.reason));
    }
  }

  /**
   * PDF 리포트 이메일 발송 공통 로직
   */
  private async sendReportEmail(
    getBody: {
      orderId: number;
      to: string;
      subject: string;
      content: string;
      pdfBase64: string;
      pdfFileName: string;
      companyType?: CompanyType;
    },
    user: ILoginUserInfo,
    ipAddress: string,
    logMeta: { requestUrl: string; actionType: string; counter?: ReportCounterColumns },
  ): Promise<{ success: boolean; message: string }> {
    const { orderId, to, subject, content, pdfBase64, pdfFileName, companyType } = getBody;

    await this.findDeliveryCompleteOrderInViewScope(user, orderId);

    // 발행 카운트용 컬럼명을 메일 발송 '전에' 해석한다.
    // 엔티티 프로퍼티가 리네임되면 여기서 undefined 가 되는데(ReportCounterColumns 는 문자열
    // 리터럴이라 컴파일이 못 잡는다), 발송 뒤에 터뜨리면 "메일은 나갔는데 500" → 운영자 재시도
    // → 고객사 중복 수신이 된다. 발송 전에 확인하면 설정 오류는 fail-fast 로 드러나고
    // 비가역 행위는 아직 일어나지 않은 상태다.
    const countDbColumn = logMeta.counter
      ? this.orderRepository.metadata.findColumnWithPropertyName(logMeta.counter.countColumn)?.databaseName
      : undefined;
    if (logMeta.counter && !countDbColumn) {
      throw new InternalServerErrorException(
        `[REPORT] 발행 카운트 컬럼을 해석하지 못했습니다: ${logMeta.counter.countColumn}. 엔티티 정의를 확인하세요.`,
      );
    }

    // 이메일 주소 파싱 (첫번째: to, 나머지: cc)
    const emails = to
      .split(',')
      .map((email) => email.trim())
      .filter((email) => email);
    const toEmail = emails[0];
    const ccEmails = emails.length > 1 ? emails.slice(1).join(', ') : undefined;

    // 이메일 발송
    const result = await this.mailSendSmtp.send({
      to: toEmail,
      cc: ccEmails,
      subject,
      content,
      companyType,
      attachments: [
        {
          filename: pdfFileName,
          content: Buffer.from(pdfBase64, 'base64'),
          contentType: 'application/pdf',
        },
      ],
    });

    // 활동 로그 기록 — best-effort. 카운터 갱신과 **같은 이유**로 삼킨다.
    //
    // 이 시점엔 mailSendSmtp.send() 가 이미 끝났다(비가역). 여기서 DB INSERT 가 실패해
    // 예외가 밖으로 나가면 500 이 되고, 운영자는 "전송 실패"로 읽어 재시도한다 →
    // 고객사가 같은 메일을 두 번 받는다. 되돌릴 수 없는 쪽(중복 발송)보다 되돌릴 수 있는
    // 쪽(감사 기록 누락)을 택한다 — 아래 카운터 갱신에 적용한 판단과 동일하다.
    //
    // ⚠️ 삼키는 것은 **발송 이후**의 기록 실패뿐이다. 발송 자체의 실패(result.success=false)는
    //    바로 아래에서 그대로 500 으로 올린다. 그 경우엔 메일이 나가지 않았으므로 재시도가 옳다.
    try {
      await this.activityLogService.createLog({
        userId: user.id,
        userEmail: user.email,
        method: 'POST',
        requestUrl: logMeta.requestUrl,
        actionType: logMeta.actionType,
        ipAddress,
        statusCode: result.success ? 200 : 500,
        result: result.success ? ActivityLogResult.SUCCESS : ActivityLogResult.FAILURE,
        responseTime: 0,
        requestParams: {
          orderId,
          to: toEmail,
          cc: ccEmails || null,
          subject,
          pdfFileName,
          messageId: result.messageId,
          error: result.error,
        },
        errorMessage: result.error || undefined,
      });
    } catch (error) {
      this.logger.error(
        `[REPORT] 메일 발송 결과를 activity_log 에 남기지 못했다 — 발행 이력 모달이 비게 된다. ` +
          `orderId: ${orderId}, actionType: ${logMeta.actionType}, sendSuccess: ${result.success}, ` +
          `messageId: ${result.messageId ?? '-'}, ` +
          `message: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!result.success) {
      throw new InternalServerErrorException(result.error || '이메일 발송에 실패했습니다.');
    }

    // 발행 카운트 반영 — 이메일 전송도 "발행"으로 집계한다(실무 확인 규칙).
    // 이 갱신이 없으면 정산 목록의 발행 상태가 '-' 로 남고 isPublished=false(미발행) 필터에도
    // 계속 잡혀, 담당자가 이미 보낸 건을 다시 발행하게 된다.
    //
    // 순서 주의: activity_log 기록과 실패 throw 뒤에 둔다.
    //  - 메일 발송은 이미 나간 비가역 행위라, 카운터 갱신이 실패하더라도 발송 기록은 남아야 한다.
    //  - 발송 실패 건은 여기 도달하지 않는다 → 실패를 '발행 완료'로 표시하지 않는다.
    //
    // save() 가 아니라 원자 UPDATE 를 쓰는 이유.
    //
    // ⚠️ "save() 는 전 컬럼을 되쓴다"가 아니다. TypeORM 0.3 의 save() 는 저장 직전 해당 행을
    //    재조회하고(SubjectDatabaseEntityLoader) 엔티티와 비교해 **변경된 컬럼만** UPDATE 한다
    //    (SubjectChangedColumnsComputer.computeDiffColumns). 전 컬럼 덮어쓰기는 일어나지 않는다.
    //
    // 실제 위험은 그 **재조회 때문에** 생기는 lost update 다. read-modify-write 인 단건 PDF 경로가
    //   1) order.deliveryCompleteReportCount 를 0 → 1 로 올려두고
    //   2) save() 가 재조회하기 직전에 이 경로가 `count = count + 1` 을 커밋하면
    //   3) 재조회값(1)과 엔티티값(1)이 같아 "변경 없음"으로 판정된다
    // → PDF 의 증가가 조용히 사라지고 lastSource 만 덮인다(발행 2회인데 count=1, 표시는
    //   '다운로드 완료'). 창이 밀리초라 확률은 낮다.
    //
    // 이 경로가 `col + 1` 을 쓰면 자신의 증가는 어떤 순서에서도 유실되지 않는다.
    // (단건 PDF 경로 deliveryCompleteReportPdf / orderCompleteReportPdf 는 아직 read-modify-write
    //  + save() 다. 그쪽도 원자 UPDATE 로 통일하면 위 조합이 통째로 사라진다 — 별도 티켓.)
    //
    // count 와 source 를 한 문장으로 갱신한다. 두 문장으로 나누면 사이에서 실패했을 때
    // count=1 / source=NULL 이 남아 formatReportStatus 폴백이 '다운로드 완료'로 오표시한다
    // (아무도 다운로드한 적 없는데). 증가는 DB 측 `col + 1` 이라 동시 요청에도 유실되지 않는다.
    //
    // best-effort: 실패해도 throw 하지 않는다. 이 시점엔 메일이 이미 고객사로 나갔으므로(비가역),
    // 여기서 500 을 올리면 운영자가 "전송 실패"로 읽고 재시도해 고객사가 같은 메일을 두 번 받는다.
    // 집계 누락은 activity_log(actionType=*_EMAIL)로 사후 백필할 수 있지만 중복 발송은 되돌릴 수 없다.
    // → 발송 결과를 진실대로 성공으로 응답하고, 집계 실패는 로그로 남겨 추적한다.
    if (logMeta.counter) {
      const { countColumn, sourceColumn } = logMeta.counter;
      // countDbColumn 은 발송 전에 이미 확정·검증했다(위 참조). 여기 try 는 순수하게
      // "메일은 나갔는데 DB 쓰기가 실패한" 일시적 장애만 흡수한다.
      try {
        await this.orderRepository
          .createQueryBuilder()
          .update(OrderEntity)
          .set({
            [countColumn]: () => `\`${countDbColumn}\` + 1`,
            [sourceColumn]: IReportSource.EMAIL,
          } as QueryDeepPartialEntity<OrderEntity>)
          .where('id = :id', { id: orderId })
          .execute();
      } catch (error) {
        this.logger.error(
          `[REPORT] 메일 발송은 성공했으나 발행 카운트 반영 실패 — 정산 목록에 미발행으로 남는다. ` +
            `orderId: ${orderId}, column: ${countColumn}, actionType: ${logMeta.actionType}, ` +
            `message: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      success: true,
      message: '이메일이 성공적으로 발송되었습니다.',
    };
  }

  /**
   * 발송완료리포트 이메일 발송
   */
  async sendDeliveryCompleteReportEmail(
    getBody: OrderDeliveryCompleteReportEmailReqDto,
    user: ILoginUserInfo,
    ipAddress: string,
  ): Promise<{ success: boolean; message: string }> {
    return this.sendReportEmail(getBody, user, ipAddress, {
      requestUrl: '/order/delivery-complete/report/email',
      actionType: 'DELIVERY_COMPLETE_REPORT_EMAIL',
      counter: {
        countColumn: 'deliveryCompleteReportCount',
        sourceColumn: 'deliveryReportLastSource',
      },
    });
  }

  /**
   * 거래명세서 이메일 발송
   */
  async sendTransactionStatementReportEmail(
    getBody: OrderTransactionStatementEmailReqDto,
    user: ILoginUserInfo,
    ipAddress: string,
  ): Promise<{ success: boolean; message: string }> {
    return this.sendReportEmail(getBody, user, ipAddress, {
      requestUrl: '/order/transaction-statement/report/email',
      actionType: 'TRANSACTION_STATEMENT_EMAIL',
      counter: {
        countColumn: 'orderCompleteReportCount',
        sourceColumn: 'transactionStatementLastSource',
      },
    });
  }

  /**
   * 파기확약서 이메일 발송
   */
  async sendDestructionCertificateReportEmail(
    getBody: OrderDestructionCertificateEmailReqDto,
    user: ILoginUserInfo,
    ipAddress: string,
  ): Promise<{ success: boolean; message: string }> {
    await this.assertDestructionCertificateIssuable(getBody.orderId, user);

    return this.sendReportEmail(getBody, user, ipAddress, {
      requestUrl: '/order/destruction-certificate/report/email',
      actionType: 'DESTRUCTION_CERTIFICATE_EMAIL',
      // counter 없음 — 파기증명서는 발행 카운트 컬럼도, 정산 목록 표시 컬럼도 존재하지 않는다.
      // 발행 이력은 activity_log(DESTRUCTION_CERTIFICATE_EMAIL)에만 남는다.
    });
  }

  /**
   * 주문 목록 기간 검색 기준 적용
   * - REGISTER (기본): order.register_at 기준
   * - SEND: 해당 주문에 속한 order_delivery.actual_send_at 중 하나라도 범위 내면 포함 (EXISTS)
   *   → 발송 이력이 없는 주문은 자연 제외, LEFT JOIN 행 중복으로 인한 페이징 부정확 회피
   */
  private applyOrderDateCondition(
    queryBuilder: ReturnType<Repository<OrderEntity>['createQueryBuilder']>,
    dateType: IOrderDateType | undefined,
    startAt: string | undefined,
    endAt: string | undefined,
  ): ReturnType<Repository<OrderEntity>['createQueryBuilder']> {
    if (dateType !== IOrderDateType.SEND) {
      return QueryBuilderDateCondition(queryBuilder, 'order', 'registerAt', startAt, endAt);
    }

    const conditions: string[] = [];
    const params: Record<string, string> = {};
    if (startAt) {
      conditions.push('od_send.actual_send_at >= :sendStartAt');
      params.sendStartAt = startAt.replace('T', ' ');
    }
    if (endAt) {
      conditions.push('od_send.actual_send_at <= :sendEndAt');
      params.sendEndAt = endAt.replace('T', ' ');
    }
    if (conditions.length === 0) {
      return queryBuilder;
    }

    return queryBuilder.andWhere(
      `EXISTS (
        SELECT 1
        FROM order_delivery od_send
        INNER JOIN order_product_mapping opm_send ON opm_send.id = od_send.order_product_mapping_id
        WHERE opm_send.order_id = order.id
          AND ${conditions.join(' AND ')}
      )`,
      params,
    );
  }

  /**
   * 직발송/대행발송/이앤엠애드 접근 제어 필터
   * - 직발송: clientUserId IS NULL AND 주문자 회사가 이앤엠애드가 아닌 건
   * - 대행발송: clientUserId IS NOT NULL (고객사/담당자가 지정된 대리 주문)
   * - 이앤엠애드: clientUserId IS NULL AND 주문자 회사가 이앤엠애드인 건
   *
   * - SUPER_ADMIN: sendingType 파라미터로 필터링 (전체 접근 가능)
   * - OPERATION_ADMIN: 직발송 건 + 본인 배정 대행발송 건만 조회
   * - 기타 (CORPORATE_ADMIN 등): 직발송 건 + 본인이 고객으로 지정된 대행발송 건만 조회
   *
   * 이앤엠애드 식별: userCompany.businessNumber로 판별 (COMPANY_INFO 상수 참조)
   */
  private applyDirectSendingFilter<T extends ObjectLiteral>(
    queryBuilder: SelectQueryBuilder<T>,
    user: ILoginUserInfo,
    sendingType?: IOrderSendingType,
  ): void {
    if (user.authority === IUserAuthority.SUPER_ADMIN) {
      this.applySendingTypeFilter(queryBuilder, sendingType);
      return;
    }

    if (user.authority === IUserAuthority.OPERATION_ADMIN) {
      queryBuilder.andWhere('(order.clientUserId IS NULL OR order.operationUserId = :currentUserId)', {
        currentUserId: user.id,
      });
      this.applySendingTypeFilter(queryBuilder, sendingType);
      return;
    }

    queryBuilder.andWhere(
      '(order.clientUserId IS NULL OR (order.clientUserId = :currentUserId AND order.apiAppId IS NULL))',
      {
        currentUserId: user.id,
      },
    );
  }

  private applySendingTypeFilter<T extends ObjectLiteral>(
    queryBuilder: SelectQueryBuilder<T>,
    sendingType?: IOrderSendingType,
  ): void {
    if (sendingType === IOrderSendingType.AGENCY) {
      queryBuilder.andWhere('order.clientUserId IS NOT NULL');
    } else if (sendingType === IOrderSendingType.DIRECT) {
      queryBuilder.andWhere('order.clientUserId IS NULL');
      queryBuilder.andWhere(
        '(userCompany.businessNumber IS NULL OR userCompany.businessNumber NOT IN (:...internalBizNos))',
        { internalBizNos: INTERNAL_BUSINESS_NUMBERS },
      );
    } else if (sendingType === IOrderSendingType.ENMAD) {
      queryBuilder.andWhere('order.clientUserId IS NULL');
      queryBuilder.andWhere('userCompany.businessNumber IN (:...internalBizNos)', {
        internalBizNos: INTERNAL_BUSINESS_NUMBERS,
      });
    }
  }
}
