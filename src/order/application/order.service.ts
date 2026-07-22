import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  Query,
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
} from '../api/order.res.dto';
import { OrderEntity } from '../../entity/order.entity';
import { InjectRepository } from '@nestjs/typeorm';
import {
  EntityManager,
  In,
  LessThanOrEqual,
  MoreThanOrEqual,
  ObjectLiteral,
  QueryRunner,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { QueryBuilderDateCondition } from '../../common/infra/query.builder.date.condition';
import { OrderViewDto } from '../api/dto/order.view.dto';
import { DateDateFormatStr, DateFormatStr } from '../../common/domain/date.format.str';
import { format } from 'date-fns';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { IOrderStatus } from '../interface/order.status';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { Transactional, runOnTransactionCommit } from 'typeorm-transactional';
import { OrderCancelNotificationService } from './order.cancel.notification.service';
import { isDirectCustomerCancelTarget } from '../domain/order.cancel.notification.policy';
import {
  resolveDestructionCertificateGate,
  destructionCertificateBlockMessage,
} from '../domain/destruction.certificate.gate';
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
import { listToMap, listToMapValue } from '../../util/map.util';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { CreateTransactionId } from '../domain/create.transaction.id';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { DeliveryCreateCouponImage } from '../../delivery/infra/delivery.create.coupon.image';
import { createExportTempPath } from '../../util/file.util';
import { UserEntity } from '../../entity/user.entity';
import { UserCompanyEntity } from '../../entity/user.company.entity';
import {
  buildPartnerSettleSnapshot,
  buildLineProductSnapshot,
  buildOrderClientUserSnapshot,
  buildOrderOperationUserSnapshot,
  buildOrderUserSnapshot,
  buildPriceDivergence,
  readBillingView,
  readClientUserView,
  readLineProductView,
  readOperationPersonName,
  readUserView,
} from '../util/order.snapshot.builder';
import {
  assertLineIdsValid,
  OwnedLine,
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
  OrderPdfDetailProductDto,
  OrderViewDeliveryDto,
} from '../api/dto/order.detail.product.dto';
import { normalizeDate } from '../../util/time.util';
import { join } from 'path';
import * as process from 'node:process';
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
import { calculateOrderSettlementAmount, buildSettlementDisplayLines } from '../../util/settle-fee.util';
import { OrderCustomerViewDto } from '../api/dto/order.customer.view.dto';
import { MaskingUtil } from '../../common/utils/masking.util';
import { resolveExpireDays } from '../../common/utils/expire.util';
import { createTempOrderCode, deriveOrderCodeFromId } from '../domain/order.code';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { PhoneUtil } from '../../common/utils/phone.util';
import { DeliveryBatchService } from '../../delivery/application/delivery.batch.service';
import { IOrderSendMethod } from '../interface/order.send.method';
import { IOrderSendingType } from '../interface/order.sending.type';
import {
  canForceConfirmDelivery,
  canTransitionDelivery,
  shouldExposeSsgBalanceCheck,
} from '../domain/order.delivery-transition-authority.helper';
import { IOrderDateType } from '../interface/order.date.type';
import { OrderEncryptKey } from '../../order_receive/interface/order.encrypt.key';
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
import { OrderConfirmationReleaseService } from '../../wallet/application/order-confirmation-release.service';
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
import { EmailType } from '../../mail/domain/email.type';
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
  startAt?: string;
  endAt?: string;
  searchType?: OrderSearchType;
  searchKeyword?: string;
  sendingType?: IOrderSendingType;
  dateType?: IOrderDateType;
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

  private async findOrderProductMappingInViewScope(
    user: ILoginUserInfo,
    orderProductMappingId: number,
    relations: Array<'product' | 'product.partnerCompany'> = [],
  ): Promise<OrderProductMappingEntity | null> {
    let queryBuilder = this.orderProductMappingRepository
      .createQueryBuilder('orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('order.user', 'user')
      .where('orderProductMapping.id = :id', { id: orderProductMappingId });

    if (relations.includes('product') || relations.includes('product.partnerCompany')) {
      queryBuilder = queryBuilder.leftJoinAndSelect('orderProductMapping.product', 'product');
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

      // 발송 실패 건 포함 여부 확인 (활성 배송건만)
      const hasFailedDelivery =
        order.orderProductMappings?.some((mapping) =>
          mapping.orderDeliveries
            ?.filter((delivery) => delivery.deletedAt == null)
            .some(
              (delivery) =>
                delivery.status === IOrderDeliveryStatus.FAIL || delivery.status === IOrderDeliveryStatus.FAIL_SMS,
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

      // 상품별 예약 발송시간 배열: RESERVE 상품 중 분 단위 distinct ≥ 2일 때만 채움
      const reserveMappings = (order.orderProductMappings ?? []).filter(
        (m) => m.sendType === 'RESERVE' && m.sendRequestAt,
      );
      const minuteSlots = new Set(reserveMappings.map((m) => Math.floor(m.sendRequestAt!.getTime() / 60000)));
      let productSendTimes: { productName: string; sendRequestAt: string; actualSendAt: string | null }[] | undefined;
      if (minuteSlots.size >= 2) {
        productSendTimes = reserveMappings.map((m) => {
          const mappingActualSendAt =
            (m.orderDeliveries ?? [])
              .filter(
                (d) =>
                  d.deletedAt == null &&
                  d.actualSendAt &&
                  (d.status === IOrderDeliveryStatus.COMPLETE || d.status === IOrderDeliveryStatus.COMPLETE_SMS),
              )
              .reduce<Date | null>((max, d) => (max === null || d.actualSendAt! > max ? d.actualSendAt! : max), null) ??
            null;
          return {
            productName: m.product?.name ?? '(삭제된 상품)',
            sendRequestAt: format(m.sendRequestAt!, DateFormatStr),
            actualSendAt: mappingActualSendAt ? format(mappingActualSendAt, DateFormatStr) : null,
          };
        });
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

    if (getQuery.includeSettlement && OrderService.canViewCustomerSettlement(user)) {
      await this.attachCustomerSettlement(orderList, resultList);
    }

    return { list: resultList, totalPage, totalCount, currentPage: page };
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
   * 응답 페이지 내 distinct 고객사(settlement_code)에 대해 wallet_account 를 1회 배치 조회 후
   * remainServiceAmount 를 map 조인한다 (행별 재계산·N+1 없음).
   * - settleCondition SoT = wallet_account.settle_condition (user 컬럼은 deprecated).
   * - remainServiceAmount = creditLimit + depositBalance − creditUsedAmount − creditExcessAmount, 0-clamp.
   * - wallet_account 미존재 고객사는 customerSettlement 필드를 붙이지 않는다(생략).
   */
  private async attachCustomerSettlement(orders: OrderEntity[], views: OrderViewDto[]): Promise<void> {
    const settlementCodeOf = (order: OrderEntity): string | null =>
      (order.clientUser ?? order.user)?.settlementCode || null;

    const orderCodes = orders.map(settlementCodeOf);
    const settlementCodes = [...new Set(orderCodes.filter((code): code is string => code !== null))];
    if (settlementCodes.length === 0) {
      return;
    }

    const wallets = await this.walletAccountRepository.find({
      where: { ownerType: 'SETTLEMENT_CODE', ownerId: In(settlementCodes) },
    });
    const walletByCode = new Map(wallets.map((wallet) => [wallet.ownerId, wallet]));

    orderCodes.forEach((code, index) => {
      if (code === null) {
        return;
      }
      const wallet = walletByCode.get(code);
      if (!wallet) {
        return;
      }
      const remain = wallet.creditLimit + wallet.depositBalance - wallet.creditUsedAmount - wallet.creditExcessAmount;
      views[index].customerSettlement = {
        settleCondition: wallet.settleCondition,
        remainServiceAmount: Math.max(0, remain),
      };
    });
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

          orderDeliveryList.push({
            id: orderDelivery.id,
            deliveryTarget: decryptedDeliveryTarget,
            replaceCharacter1: orderDelivery.replaceCharacter1,
            replaceCharacter2: orderDelivery.replaceCharacter2,
            replaceCharacter3: orderDelivery.replaceCharacter3,
            status: orderDelivery.status,
            isResent: orderDelivery.resendAt !== null,
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

        // 해당 상품의 발송 실패 건수 계산
        const failCount = orderProductMapping.orderDeliveries.filter(
          (delivery) =>
            delivery.status === IOrderDeliveryStatus.FAIL || delivery.status === IOrderDeliveryStatus.FAIL_SMS,
        ).length;

        productList.push({
          id: orderProductMapping.id,
          product: product,
          orderDeliveryList: orderDeliveryList,

          emailSendType: orderProductMapping.emailSendType,
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
      isPreSettle: order.user!.settleCondition === IUserSettleCondition.PRE_PAYMENT,
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
        });
      }
    }

    let couponExpiration: number | null = null;
    if (order.type === IOrderType.SSG && productList.length > 0) {
      couponExpiration = productList[0].product?.expireDay ?? null;
    }

    const clientView = readClientUserView(order);

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
      isPreSettle: order.user!.settleCondition === IUserSettleCondition.PRE_PAYMENT,
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
        for (const orderDelivery of orderProductMapping.orderDeliveries) {
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
    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.id = :id', { id: getBody.id });

    const order = await queryBuilder.getOne();

    if (!order) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    order.deliveryCompleteReportCount++;
    order.deliveryReportLastSource = getBody.source || 'DOCUMENT';

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
      requestParams: { orderId: getBody.id, source: getBody.source, unmasked: getBody.unmasked === true },
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
    let vat = 0;
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
    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.id = :id', { id: getBody.id });

    const order = await queryBuilder.getOne();

    if (!order) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    order.orderCompleteReportCount++;
    order.transactionStatementLastSource = getBody.source || 'DOCUMENT';

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
      requestParams: { orderId: getBody.id, source: getBody.source },
    });

    return;
  }

  async destructionCertificatePdf(
    getBody: OrderGetDestructionCertificatePdfReqDto,
    user: ILoginUserInfo,
    ipAddress: string,
  ): Promise<void> {
    await this.assertDestructionCertificateIssuable(getBody.id);

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
          for (const orderDelivery of orderProductMapping.orderDeliveries) {
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
    let vat = 0;
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
        await this.forbiddenWordBlockLogRepository.insert({
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

    const order = await this.orderRepository.findOne({
      where: {
        id: id,
        // userId: user.id,
        // status: IOrderStatus.TEMP,
      },
    });

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

    // mapping id 소유권/중복 검증 — 헤더 저장 이전에 실행하여 뮤테이션 전 400 보장
    const deleteOrderProductMappingList = await this.orderProductMappingRepository.find({
      where: {
        orderId: orderId,
      },
    });
    const ownedMap = new Map<number, OwnedLine>(
      deleteOrderProductMappingList.map((m) => [
        m.id,
        {
          productId: m.productId,
          snapshot: {
            snapshotProductPrice: m.snapshotProductPrice,
            snapshotProductName: m.snapshotProductName,
            snapshotProductBrandName: m.snapshotProductBrandName,
            snapshotProductExpireDay: m.snapshotProductExpireDay,
            snapshotProductImagePath: m.snapshotProductImagePath,
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

    // 대행주문 관련 정보 업데이트
    order.clientUserId = clientUserId;
    if (clientUserId) {
      // 대행주문인 경우 현재 관리자를 운영 담당자로 자동 배정 (createTemp와 동일 로직)
      order.operationUserId = user.id;
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
        oneOrderDelivery.sendRequestAt = productSendAt;
        orderDeliveryCreateList.push(oneOrderDelivery);
      }
    }

    await this.orderDeliveryRepository.insert(orderDeliveryCreateList);

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

  @Transactional()
  async deliveryConfirmed(
    user: ILoginUserInfo,
    getBody: OrderDeliveryConfirmedReqDto,
  ): Promise<OrderDeliveryConfirmed> {
    const { id } = getBody;

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

    if (getBody.forceConfirm && !canForceConfirmDelivery(currentUser)) {
      throw new ForbiddenException('강제 발송확정 권한이 없습니다.');
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

          // 매핑에 할인 정보 저장
          mapping.fee = fee;
          mapping.priceAdjustment = priceAdjustment;
          mappingsToUpdate.push(mapping);
        }
      }

      // 할인/할증 상태 저장
      mappingPriceAdjustments.set(mapping.id, priceAdjustment);
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
    const resolvedSettlePolicy = hasSettleInput
      ? null
      : await this.resolveSettlePolicy(order, oneUser.company);
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

        // 신용초과 판정 = allocation.creditExcessAmount 기준 (finalAmount 아님)
        if (allocation.creditExcessAmount > 0) {
          // 1차/2차 공통 신용초과 응답 빌더. 두 응답이 동일 필드를 내려야 함 —
          // walletAccountId/requestedAmount/requestedCreditExcessAmount 는 신용초과 사전 승인
          // (POST /credit-excess-approvals) 요청 body 로 그대로 전달되며, 누락 시 승인 API 400 회귀(요청4).
          const buildCreditExcessResponse = (message: 'credit_excess' | 'credit_excess_pending_approval') =>
            ({
              message,
              creditExcess: true,
              excessAmount: allocation.creditExcessAmount,
              remainServiceAmount,
              finalAmount: allocation.payableSettlementAmount,
              walletAccountId: String(wallet.id),
              requestedAmount: allocation.payableSettlementAmount,
              requestedCreditExcessAmount: allocation.creditExcessAmount,
              ...this.allocationDetail(allocation),
            }) as OrderDeliveryConfirmed;

          if (!getBody.forceConfirm) {
            // 1차 호출: 신용초과 미리보기 응답 (SSG confirmEventBalance 미실행, DB 차감 없음)
            return buildCreditExcessResponse('credit_excess');
          }
          // 2차 호출 (forceConfirm=true) + 사전 승인 ID 미주입 → 승인 대기 응답 (SSG side effect 차단).
          if (!getBody.creditExcessApprovalId) {
            this.logger.warn(
              `신용초과 사전 승인 누락: orderId=${order.id}, 초과액=${allocation.creditExcessAmount.toLocaleString()}원`,
            );
            return buildCreditExcessResponse('credit_excess_pending_approval');
          }
          order.isCreditExcess = true;
          this.logger.warn(
            `신용초과 발송확정: orderId=${order.id}, 초과액=${allocation.creditExcessAmount.toLocaleString()}원, 결제=${allocation.payableSettlementAmount.toLocaleString()}원`,
          );
        }

        // 3-1. SSG 가차감 확정 (진행 결정 + 사전 승인 통과 후에만 실행)
        if (order.type === IOrderType.SSG) {
          await this.ssgEventService.confirmEventBalance(order.id);
        }

        // 신용초과 사전 승인 ID 전달 (CreditExcessApprovalService 4단계 워크플로 Step D).
        // 신용초과 미발생 시 null. 발생 시 운영자가 사전 발급한 approvalId 필수 — 미주입 시
        // persistAllocation 가 credit_excess_approval_required 로 throw → TX rollback.
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
            creditExcessApprovalId: getBody.creditExcessApprovalId ?? null,
          },
          externalManager,
        );
        // persistAllocation 이 lock 후 재계산한 최종 allocation 사용 (pre-lock allocation 은 stale 가능).
        const finalAllocation = persistResult.finalAllocation;

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
        if (finalAmount > remainServiceAmount) {
          if (!getBody.forceConfirm) {
            // 1차 호출: 초과 정보 응답 반환 (SSG confirmEventBalance 미실행)
            return {
              message: 'credit_excess',
              creditExcess: true,
              excessAmount: finalAmount - remainServiceAmount,
              remainServiceAmount,
              finalAmount,
            };
          }
          order.isCreditExcess = true;
          this.logger.warn(
            `신용초과 발송확정: orderId=${order.id}, 초과액=${(finalAmount - remainServiceAmount).toLocaleString()}원, 필요=${finalAmount.toLocaleString()}원, 가능=${remainServiceAmount.toLocaleString()}원`,
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

  @Transactional()
  async deliveryCancel(user: ILoginUserInfo, getBody: OrderDeliveryCancelReqDto) {
    const { id, cancelReason } = getBody;

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
    const reserveSendTimes = (order.orderProductMappings ?? [])
      .filter((mapping) => mapping.sendType === 'RESERVE' && mapping.sendRequestAt)
      .map((mapping) => mapping.sendRequestAt!.getTime());
    const sendRequestAtTime = reserveSendTimes.length > 0 ? Math.min(...reserveSendTimes) : 0;
    const nowTime = now.getTime();
    const diffMs = sendRequestAtTime - nowTime;
    const tenMinutesMs = 10 * 60 * 1000;

    if (order.status === IOrderStatus.DELIVERY_REQUEST || order.status === IOrderStatus.REVIEW_COMPLETE) {
      // 주문완료 또는 검토완료 상태에서 취소 허용
    } else if (order.status === IOrderStatus.DELIVERY_CONFIRMED) {
      if (diffMs < tenMinutesMs) {
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
    const isWalletManaged =
      refundAmount > 0 && (await this.walletManagedPredicate.isWalletManaged(order.id, externalManager));

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
      }
      oneUser.allSettleAmount -= creditRefund + excessRefund;
      order.settleAmount = 0;
      order.isSettleBalance = false;
      order.isCreditExcess = false;
    } else if (refundAmount > 0) {
      if (order.isSettleBalance) {
        if (isCompanyBalanceMode && oneUser.company) {
          oneUser.company.balance += refundAmount;
        } else {
          oneUser.balance += refundAmount;
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
    await this.orderDeliveryRepository.update(
      { orderProductMappingId: In(orderProductMappingIdList) },
      { status: IOrderDeliveryStatus.CANCEL },
    );
    if (isWalletManaged) {
      // wallet path 는 user.balance 를 건드리지 않으므로 update 로 좁혀 stale overwrite 차단.
      await this.userRepository.update({ id: oneUser.id }, { allSettleAmount: oneUser.allSettleAmount });
    } else {
      await this.userRepository.save(oneUser);
    }
    // 회사 레벨 balance 변경 시 company도 저장
    if (isCompanyBalanceMode && oneUser.company) {
      await this.userCompanyRepository.save(oneUser.company);
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
    const { password: _, ...requestParams } = getBody;

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

    // 최대 횟수 (상품별 2회)
    const maxLimitCount = 2;
    const barCode = '999999';

    // 알림톡일 경우 order.user도 필요하므로 항상 조인
    const orderProductMapping = await this.orderProductMappingRepository
      .createQueryBuilder('orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('order.user', 'user')
      .where('orderProductMapping.id = :id', { id: orderProductMappingId })
      .getOne();

    if (!orderProductMapping) {
      throw new BadRequestException('해당 주문-상품이 존재하지 않습니다.');
    }

    if (orderProductMapping.testDeliveryCount >= maxLimitCount) {
      throw new BadRequestException('테스트발송은 상품당 최대 2회입니다.');
    }

    const firstDelivery = await this.orderDeliveryRepository.findOne({
      where: { orderProductMappingId },
      order: { id: 'ASC' },
    });
    const expireAt = this.resolveOrderExpireAt(orderProductMapping, firstDelivery?.expireAt);
    const expireDate = expireAt ? dayjs(expireAt).tz('Asia/Seoul').format('YYYY. MM. DD') : null;

    // 2. 쿠폰이미지 만들기
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

    const deliveryMethod = orderProductMapping.sendMethod!;
    const encryptedDeliveryTarget = this.cryptoCipher.encryptDeliveryTarget(
      PhoneUtil.normalizeDeliveryTarget(deliveryTarget),
    );

    // test_order_delivery 테이블에 저장 (oneSend에서 테스트 발송 여부를 판단하여 PIN 재발급 스킵)
    const testOrderDelivery = new TestOrderDeliveryEntity();
    testOrderDelivery.status = IOrderDeliveryStatus.COMPLETE;
    testOrderDelivery.orderProductMappingId = orderProductMapping.id;
    testOrderDelivery.deliveryMethod = deliveryMethod;
    testOrderDelivery.deliveryTarget = encryptedDeliveryTarget;
    testOrderDelivery.imagePath = imagePath;

    testOrderDelivery.sendRequestAt = new Date();
    testOrderDelivery.expireAt = expireAt;
    testOrderDelivery.barCode = barCode;
    testOrderDelivery.personalCode = barCode;

    const savedTestOrderDelivery = await this.testOrderDeliveryRepository.save(testOrderDelivery);
    const testOrderDeliveryId = savedTestOrderDelivery.id;

    const orderDelivery = new OrderDeliveryEntity();
    orderDelivery.deliveryMethod = deliveryMethod;
    orderDelivery.orderProductMappingId = orderProductMapping.id;
    orderDelivery.deliveryTarget = encryptedDeliveryTarget;
    orderDelivery.barCode = barCode;
    orderDelivery.personalCode = barCode;
    orderDelivery.orderProductMapping = orderProductMapping;
    orderDelivery.imagePath = imagePath;
    orderDelivery.expireAt = expireAt;

    // 3. 전송 (testOrderDeliveryId로 테스트 발송임을 전달하여 PIN 재발급 스킵)
    const isSuccess = await this.deliveryBatchService.oneSend(orderDelivery, false, testOrderDeliveryId);

    // 발송 실패 시 에러 throw (횟수 증가하지 않음)
    if (!isSuccess) {
      throw new BadRequestException('테스트 발송에 실패했습니다. 수신자 정보를 확인해주세요.');
    }

    // 4. 테스트 발송 횟수 증가 (상품별) - 발송 성공 시에만 증가
    orderProductMapping.testDeliveryCount += 1;
    await this.orderProductMappingRepository.save(orderProductMapping);
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

    const order = await this.orderRepository.findOne({
      where: {
        id: orderId,
      },
    });

    if (!order) {
      return response;
    }

    const queryBuilder = this.orderProductMappingRepository
      .createQueryBuilder('orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .where('orderProductMapping.id != :id', { id: orderId })
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

    // 독려문자 사용 설정 시 유효기간 검증
    if (encourageDay !== null) {
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
  private async assertDestructionCertificateIssuable(orderId: number): Promise<void> {
    const order = await this.orderRepository.findOne({
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
    logMeta: { requestUrl: string; actionType: string },
  ): Promise<{ success: boolean; message: string }> {
    const { orderId, to, subject, content, pdfBase64, pdfFileName, companyType } = getBody;

    // 주문 존재 여부 확인
    const order = await this.orderRepository.findOne({
      where: { id: orderId },
    });

    if (!order) {
      throw new BadRequestException('해당 주문이 존재하지 않습니다.');
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

    // 활동 로그 기록
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

    if (!result.success) {
      throw new InternalServerErrorException(result.error || '이메일 발송에 실패했습니다.');
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
    await this.assertDestructionCertificateIssuable(getBody.orderId);

    return this.sendReportEmail(getBody, user, ipAddress, {
      requestUrl: '/order/destruction-certificate/report/email',
      actionType: 'DESTRUCTION_CERTIFICATE_EMAIL',
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
