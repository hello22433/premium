import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Like, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import dayjs from 'dayjs';

import { OrderEntity } from '../../entity/order.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { ProductEntity } from '../../entity/product.entity';
import { UserEntity } from '../../entity/user.entity';
import { DeliverySendHistoryEntity } from '../../entity/delivery.send.history.entity';
import { UserSyncProductEventMappingEntity } from '../../entity/user.sync.product.event.mapping.entity';
import { ExternalApiAccountEntity } from '../../entity/external.api.account.entity';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { UserDiscountEntity } from '../../entity/user.discount.entity';
import { IUserSyncProductStatus } from '../../user_sync_product/interface/user.sync.product.status';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserSettleMethod } from '../../user/interface/user.settle.method';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { findMatchingDiscount } from '../../user_discount/domain/discount.matcher';
import { OrderFeeCalculator, applyCardSurcharge } from '../../order/domain/order.fee.calculator';
import {
  buildLineProductSnapshot,
  buildOrderClientUserSnapshot,
  buildOrderOperationUserSnapshot,
  buildOrderUserSnapshot,
} from '../../order/util/order.snapshot.builder';

import { IOrderType } from '../../order/interface/order.type';
import { IOrderStatus } from '../../order/interface/order.status';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { IOrderSendMethod } from '../../order/interface/order.send.method';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { IProductUseStatus } from '../../product/interface/product.status';
import { IProductType } from '../../product/interface/product.type';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';

import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { DeliverySendService } from '../../delivery/application/delivery.send.service';
import { RefundLedgerService } from '../../delivery/application/refund-ledger.service';
import { SsgRecoveryService } from '../../delivery/application/ssg-recovery.service';
import { SsgRecoveryResult } from '../../delivery/interface/ssg.recovery.result';
import { SsgEventService } from '../../ssg_event/application/ssg.event.service';
import { ProductService } from '../../product/application/product.service';
import { OrderFromService } from '../../order_from/application/order.from.service';
import { systemFromPhoneNumber } from '../../const';

import { ExternalApiException } from '../api/external.api.exception.filter';
import { translatePartnerError } from './partner.error.translator';
import {
  ExternalApiResponse,
  ExternalCouponStatus,
  ExternalDeliveryStatus,
  OrderResponseData,
  SsgOrderResponseData,
  OrderStatusResponseData,
  SsgOrderStatusResponseData,
  ProductResponseData,
} from '../api/dto/external.api.response.dto';
import { CreateExternalOrderDto, CreateExternalSsgOrderDto } from '../api/dto/external.api.request.dto';
import { ApiRequestContext } from '../api/api-request-context';
import { getBillingUserId } from '../../order/domain/order.billing-user.helper';
import { ApiCustomerMappingResolver } from './api.customer.mapping.resolver';

import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { DeliveryCreateCouponImage } from '../../delivery/infra/delivery.create.coupon.image';
import { CreateCode } from '../../common/domain/create.code';
import { OrderPrefixCode, OrderDigitNumber } from '../../order/domain/order.code';
import { CreateApiTransactionId } from '../../order/domain/create.transaction.id';
import { applyReplaceCharacters } from '../../common/utils/replace-characters.util';
import { resolveExpireDays, couponTokenExpiry } from '../../common/utils/expire.util';
import { addDays } from 'date-fns';
import { ulid } from 'ulid';

import { WalletCutoverConfig, WalletCutoverMode } from '../../wallet/config/wallet-cutover.config';
import { WalletAccountResolverService } from '../../wallet/application/wallet-account-resolver.service';
import { WalletAllocationInputBuilder } from '../../wallet/application/wallet-allocation-input.builder';
import { PaymentAllocationService } from '../../wallet/application/payment-allocation.service';
import {
  OrderConfirmationWalletService,
  PersistAllocationInput,
  PersistAllocationResult,
} from '../../wallet/application/order-confirmation-wallet.service';
import { CreditExcessApprovalRequiredError } from '../../wallet/application/credit-excess-approval-required.error';
import { WalletManagedPredicate } from '../../wallet/application/wallet-managed.predicate';
import { RefundPoolService } from '../../wallet/application/refund-pool.service';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { OrderPaymentRefundEventType } from '../../entity/order.payment.refund.event.entity';
import { OrderDeliveryAttemptEntity, OrderDeliveryAttemptType } from '../../entity/order.delivery.attempt.entity';

@Injectable()
export class ExternalApiService {
  private readonly logger = new Logger('ExternalApiService');

  constructor(
    @InjectRepository(OrderEntity)
    private orderRepository: Repository<OrderEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
    @InjectRepository(OrderProductMappingEntity)
    private orderProductMappingRepository: Repository<OrderProductMappingEntity>,
    @InjectRepository(ProductEntity)
    private productRepository: Repository<ProductEntity>,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    @InjectRepository(DeliverySendHistoryEntity)
    private deliverySendHistoryRepository: Repository<DeliverySendHistoryEntity>,
    @InjectRepository(UserSyncProductEventMappingEntity)
    private syncProductEventMappingRepository: Repository<UserSyncProductEventMappingEntity>,
    @InjectRepository(UserDiscountEntity)
    private userDiscountRepository: Repository<UserDiscountEntity>,
    private dataSource: DataSource,
    private partnerCompanyExternService: PartnerCompanyExternService,
    private deliverySendService: DeliverySendService,
    private ssgEventService: SsgEventService,
    private cryptoCipher: CryptoCipher,
    private refundLedgerService: RefundLedgerService,
    private productService: ProductService,
    private ssgRecoveryService: SsgRecoveryService,
    private walletCutoverConfig: WalletCutoverConfig,
    private walletAccountResolverService: WalletAccountResolverService,
    private walletAllocationInputBuilder: WalletAllocationInputBuilder,
    private paymentAllocationService: PaymentAllocationService,
    private orderConfirmationWalletService: OrderConfirmationWalletService,
    private walletManagedPredicate: WalletManagedPredicate,
    private refundPoolService: RefundPoolService,
    private orderFromService: OrderFromService,
    private mappingResolver: ApiCustomerMappingResolver,
  ) {}

  // 주문의 billing user(+company) 로드. getBillingUserId(order)=clientUserId ?? userId.
  //   단순모드 → order.userId(=default billing), 매핑모드 → order.clientUserId(=매핑 billingUser).
  // refund/cancel/ledger mirror 가 billing user 기준으로 동작하도록 환불·취소 경로에서 사용.
  // fallback(이미 로드된 동일 user, company relation 포함)이 있으면 재조회 생략(단순모드 비트동일).
  private async loadOrderBillingUser(order: OrderEntity, fallback?: UserEntity): Promise<UserEntity> {
    const billingUserId = getBillingUserId(order);
    if (fallback && fallback.id === billingUserId) {
      return fallback;
    }
    const billingUser = await this.userRepository.findOne({
      where: { id: billingUserId },
      relations: ['company'],
    });
    if (!billingUser) {
      throw new ExternalApiException('4003', '등록되지 않은 고객 매핑', `billing user 없음: ${billingUserId}`);
    }
    return billingUser;
  }

  // 관찰성(PR2 Phase 8): 주문 1건을 apiAppId→credential→billingUser→externalCustomer/Order→orderId 로 상관 로깅.
  // idempotencyKey 는 idempotency_keys(apiAppId, endpoint)로 별도 추적. clientUserId≠null = 매핑모드.
  private logOrderObservability(order: OrderEntity, ctx: ApiRequestContext): void {
    this.logger.log(
      `[EXTERNAL_ORDER] orderId=${order.id} apiAppId=${ctx.apiApp.id} apiCredentialId=${ctx.apiCredential.id} ` +
        `billingUserId=${getBillingUserId(order)} externalCustomerId=${order.externalCustomerId ?? '-'} ` +
        `externalOrderId=${order.externalOrderId ?? '-'} mode=${order.clientUserId != null ? 'MAPPING' : 'SIMPLE'}`,
    );
  }

  // ─── 잔액 헬퍼 ──────────────────────────────────────────
  // 잔액 차감 위치는 user.company.balanceManagementType으로 분기.
  //   COMPANY → user_company.balance (회사 단위 정산)
  //   그 외(PERSONAL) → user.balance (계정 단위 정산)

  private async deductBalance(billingUser: UserEntity, price: number): Promise<void> {
    const user = billingUser;
    const isCompany = user.company?.balanceManagementType === 'COMPANY';
    const result = isCompany
      ? await this.dataSource.query('UPDATE user_company SET balance = balance - ? WHERE id = ? AND balance >= ?', [
          price,
          user.companyId,
          price,
        ])
      : await this.dataSource.query('UPDATE user SET balance = balance - ? WHERE id = ? AND balance >= ?', [
          price,
          user.id,
          price,
        ]);
    if (result.affectedRows === 0) {
      throw new ExternalApiException('3002', '잔액 부족');
    }
  }

  // ─── Wallet 차감 (WALLET cutover 모드) ───────────────────
  // 내부 발송확정 WALLET 경로(order.service.ts deliveryConfirmed)를 그대로 미러.
  //   resolveByUserId(fail-closed) → builder(POINT=0, 후정산 예치금 미사용)
  //   → allocate → persistAllocation(same-tx) → R4 legacy mirror(user.balance 미기록).
  // 선정산 예치금 부족(신용초과+미승인) → CreditExcessApprovalRequiredError → 3002 변환.
  //
  // order/mapping/orderDelivery/product 는 이미 저장된 상태여야 하며(R1),
  // 호출자가 R6 관계그래프(order.orderProductMappings/mapping.orderDeliveries/mapping.product)를
  // 구성한 뒤 전달한다. ssgEvent 차감(행사잔액)은 wallet 과 독립이므로 호출자 책임.
  private async deductViaWallet(billingUser: UserEntity, order: OrderEntity, settleAmount: number): Promise<void> {
    const user = billingUser;

    // billingUserId = account.user.id (external 은 대행주문 없음, 1:1). wallet 없으면 fail-closed.
    let wallet;
    try {
      wallet = await this.walletAccountResolverService.resolveByUserId(user.id, this.dataSource.manager);
    } catch {
      throw new ExternalApiException('3002', '잔액 부족');
    }

    // external 정책: 포인트 사용 0, 후정산 예치금 미사용(선정산은 builder 가 자동 전액).
    const allocationInput = await this.walletAllocationInputBuilder.build(order, wallet, settleAmount, {
      requestedPointAmount: 0,
      depositUseEnabled: false,
      companyId: user.companyId ?? null,
    });
    const allocation = this.paymentAllocationService.allocate(allocationInput);

    const persistInput: PersistAllocationInput = {
      orderId: order.id,
      allocation,
      cardSurchargeAppliedSnapshot: order.cardSurchargeApplied,
      hasDiscountSnapshot: allocation.hasDiscount,
      // settleMethodSnapshot SoT 통일: 주문 저장값 우선, 없으면 이미 조회한 wallet SoT (회사/유저 정책 대신)
      settleMethodSnapshot: order.settleMethod ?? wallet.settleMethod,
      deliveryIdsForAttempt: allocation.lines.map((l) => l.orderDeliveryId).filter((id): id is number => id != null),
      // external 은 신용초과 승인 UI 가 없으므로 항상 미전달 → 락 후 excess 발생 시 typed throw.
      creditExcessApprovalId: null,
    };

    let persistResult: PersistAllocationResult;
    try {
      persistResult = await this.orderConfirmationWalletService.persistAllocation(
        persistInput,
        this.dataSource.manager,
      );
    } catch (error) {
      // 선정산 예치금 부족 = 신용초과 거절 → 잔액 부족으로 변환 (TX rollback).
      if (error instanceof CreditExcessApprovalRequiredError) {
        throw new ExternalApiException('3002', '잔액 부족');
      }
      throw error;
    }

    // R4 legacy mirror (same-tx, user.balance 는 기록하지 않음 — wallet ledger 가 SoT).
    const finalAllocation = persistResult.finalAllocation;
    order.settleAmount = finalAllocation.payableSettlementAmount;
    order.isSettleBalance = finalAllocation.creditUsedAmount === 0 && finalAllocation.creditExcessAmount === 0;
    order.isCreditExcess = finalAllocation.creditExcessAmount > 0;

    const isCompany = user.company?.balanceManagementType === 'COMPANY';
    if (isCompany) {
      await this.dataSource.manager.query('UPDATE user_company SET balance = balance - ? WHERE id = ?', [
        finalAllocation.depositUsedAmount,
        user.companyId,
      ]);
    }
    const allSettleDelta = finalAllocation.creditUsedAmount + finalAllocation.creditExcessAmount;
    await this.dataSource.manager.query('UPDATE user SET allSettleAmount = allSettleAmount + ? WHERE id = ?', [
      allSettleDelta,
      user.id,
    ]);

    // order 변경분 저장 (mirror 필드: settleAmount/isSettleBalance/isCreditExcess).
    await this.orderRepository.save(order);
  }

  private async refundBalance(billingUser: UserEntity, price: number): Promise<void> {
    const user = billingUser;
    const isCompany = user.company?.balanceManagementType === 'COMPANY';
    if (isCompany) {
      await this.dataSource.query('UPDATE user_company SET balance = balance + ? WHERE id = ?', [
        price,
        user.companyId,
      ]);
    } else {
      await this.dataSource.query('UPDATE user SET balance = balance + ? WHERE id = ?', [price, user.id]);
    }
  }

  // ─── Wallet 환불 (WALLET cutover 모드) ───────────────────
  // 내부 환불 경로(delivery.batch.service refundForFail / customer.service restoreBalanceOnDiscard)를 미러.
  //   latest INITIAL attempt 조회(없으면 throw=drift) → RefundPoolService.refund(same-tx) → R4 차감 mirror 의 역.
  // RefundPoolService 는 wallet ledger/wallet_account/point_grant/allocation 만 갱신하고
  // legacy mirror(user_company.balance / user.allSettleAmount)는 건드리지 않으므로(책임 경계) 여기서 별도 복원.
  // 복원 금액 = allocation 의 원 차감 총액(depositUsedAmount / creditUsedAmount+creditExcessAmount).
  // 단일 delivery 전액 환불이므로 R4 의 정확한 역연산. user.balance 미기록 원칙 유지.
  private async refundViaWallet(
    billingUser: UserEntity,
    order: OrderEntity,
    orderDelivery: OrderDeliveryEntity,
    eventType: OrderPaymentRefundEventType,
    idempotencyPrefix: 'fail_refund' | 'discard_refund',
  ): Promise<void> {
    const manager = this.dataSource.manager;
    const user = billingUser;

    const latestAttempt = await manager.findOne(OrderDeliveryAttemptEntity, {
      where: {
        orderDeliveryId: orderDelivery.id,
        attemptType: OrderDeliveryAttemptType.INITIAL,
      },
      order: { id: 'DESC' },
    });
    if (!latestAttempt) {
      throw new Error(
        `wallet-managed delivery ${orderDelivery.id} missing INITIAL attempt — drift, aborting external refund`,
      );
    }

    // R4 차감 mirror 역복원에 쓸 원 차감 총액. RefundPoolService 는 *RestoredAmount 카운터만 증가시키므로
    // depositUsedAmount/creditUsedAmount/creditExcessAmount 는 원 차감값 그대로 보존된다.
    const allocation = await manager.findOne(OrderPaymentAllocationEntity, {
      where: { orderId: order.id },
    });
    if (!allocation) {
      throw new Error(`wallet-managed order ${order.id} missing allocation — drift, aborting external refund`);
    }

    const refundResult = await this.refundPoolService.refund(
      {
        orderId: order.id,
        eventType,
        targetDeliveryIds: [orderDelivery.id],
        idempotencyKeyPrefix: `${idempotencyPrefix}:${order.id}:${orderDelivery.id}:${latestAttempt.id}`,
      },
      manager,
    );

    // R4 legacy mirror 역복원 (차감의 정확한 역). RefundPoolService 는 legacy 컬럼 미터치 → 풀 기준 이중복원 없음.
    // 단, 멱등 retry(alreadyRefunded) 면 refund 는 no-op 인데 mirror 는 무조건 전액 복원해 잔액이 이중 반영된다.
    // → 신규 환불이 실제 적용된 경우(alreadyRefunded=false)에만 mirror 를 실행한다.
    if (refundResult.alreadyRefunded) {
      this.logger.warn(
        `[EXTERNAL_REFUND] 멱등 retry — 풀 환불 no-op, legacy mirror skip (이중복원 방지). orderDelivery.id: ${orderDelivery.id}`,
      );
      return;
    }

    const isCompany = user.company?.balanceManagementType === 'COMPANY';
    if (isCompany) {
      await manager.query('UPDATE user_company SET balance = balance + ? WHERE id = ?', [
        allocation.depositUsedAmount,
        user.companyId,
      ]);
    }
    const allSettleDelta = allocation.creditUsedAmount + allocation.creditExcessAmount;
    await manager.query('UPDATE user SET allSettleAmount = allSettleAmount - ? WHERE id = ?', [
      allSettleDelta,
      user.id,
    ]);
  }

  // ─── 정산 헬퍼 ──────────────────────────────────────────
  // 일반 주문(order.service.ts)과 동일한 정산 모델을 외부 API에도 적용.
  //  - 카드할증 여부: company.settleMethod === 'CARD' (SoT. user.settleMethod 는 deprecated)
  //  - 할인/할증: user_discount 자동 매칭(findMatchingDiscount). 매칭 없으면 정가 그대로
  //  - settleAmount = applyCardSurcharge(OrderFeeCalculator(...), cardSurchargeApplied)

  private resolveCardSurchargeApplied(account: ExternalApiAccountEntity): boolean {
    return this.resolveCardSurchargeAppliedForUser(account.user);
  }

  // billingUser 기준 카드할증 판정. company.settleMethod 가 SoT (user.settleMethod 는 deprecated).
  // balanceManagementType 분기 제거 — PR1+ 모든 user 가 company 단위 공유 settlement_code 로 통합.
  private resolveCardSurchargeAppliedForUser(user: UserEntity): boolean {
    return user.company?.settleMethod === IUserSettleMethod.CARD;
  }

  private async computeSettlement(
    account: ExternalApiAccountEntity,
    product: ProductEntity,
    sendAmount: number,
  ): Promise<{
    fee: number | null;
    priceAdjustment: IPriceAdjustment | null;
    settleAmount: number;
    cardSurchargeApplied: boolean;
  }> {
    return this.computeSettlementForBilling(account.user, product, sendAmount, {
      cardSurchargeApplied: this.resolveCardSurchargeApplied(account),
    });
  }

  // billingUser 기준 정산 계산(add-only). 단순모드(billingUser=account.user)는 기존과 비트동일.
  // 카드할증 등 account 속성은 appOptions로 분리 주입(미지정 시 billingUser 기준 재현).
  private async computeSettlementForBilling(
    billingUser: UserEntity,
    product: ProductEntity,
    sendAmount: number,
    appOptions?: { cardSurchargeApplied?: boolean },
  ): Promise<{
    fee: number | null;
    priceAdjustment: IPriceAdjustment | null;
    settleAmount: number;
    cardSurchargeApplied: boolean;
  }> {
    const where: Array<{ userId?: number; partnerCompanyId?: number }> = [{ userId: billingUser.id }];
    if (product.partnerCompanyId != null) {
      where.push({ partnerCompanyId: product.partnerCompanyId });
    }
    const userDiscounts = await this.userDiscountRepository.find({ where });

    // SSG처럼 dto.amount로 sendAmount가 product.price와 다른 경우에도 정확히 매칭하도록
    // sendAmount를 priceOverride로 일관되게 전달.
    const matched = findMatchingDiscount(
      {
        price: product.price,
        category: product.category,
        classificationId: product.classificationId,
        brand: product.brand,
      },
      userDiscounts,
      sendAmount,
    );

    const fee = matched?.pricePercent ?? null;
    const priceAdjustment = matched?.priceAdjustment ?? null;

    const unitPrice =
      fee != null && priceAdjustment != null
        ? OrderFeeCalculator({ fee, priceAdjustment, price: sendAmount })
        : sendAmount;

    const cardSurchargeApplied =
      appOptions?.cardSurchargeApplied ?? this.resolveCardSurchargeAppliedForUser(billingUser);
    const settleAmount = applyCardSurcharge(unitPrice, cardSurchargeApplied);

    return { fee, priceAdjustment, settleAmount, cardSurchargeApplied };
  }

  // ─── 할당 상품 헬퍼 ─────────────────────────────────────

  private async getAssignedProductIds(userId: number): Promise<number[]> {
    return this.getAssignedProductIdsForBilling(userId);
  }

  // billingUser 기준 할당 상품 조회(add-only, 본문 이동). 단순모드 billingUserId=user.id 라 동일.
  private async getAssignedProductIdsForBilling(billingUserId: number): Promise<number[]> {
    const mappings = await this.syncProductEventMappingRepository
      .createQueryBuilder('m')
      .innerJoin('m.userSyncProductEvent', 'e')
      .select('m.productId')
      .where('e.businessUserId = :userId', { userId: billingUserId })
      .andWhere('e.status = :status', { status: IUserSyncProductStatus.ACTIVE })
      .andWhere('m.deletedAt IS NULL')
      .getMany();
    return mappings.map((m) => m.productId);
  }

  // ─── 발송 헬퍼 ──────────────────────────────────────────

  private async dispatchSend(orderDelivery: OrderDeliveryEntity): Promise<DeliverySendHistoryEntity> {
    const mapping = orderDelivery.orderProductMapping;
    const product = mapping.product;

    const decryptedTarget =
      this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.deliveryTarget) ?? orderDelivery.deliveryTarget;

    const body = applyReplaceCharacters(mapping.sendContent || '', orderDelivery);
    const memoRaw = product.memo;
    const memo =
      memoRaw && orderDelivery.deliveryMethod !== IOrderSendMethod.EMAIL && mapping.order?.type !== IOrderType.SSG
        ? applyReplaceCharacters(memoRaw, orderDelivery)
        : null;
    const tailRaw = mapping.sendTailText;
    const tailText = tailRaw ? applyReplaceCharacters(tailRaw, orderDelivery) : null;

    const encryptKey = this.cryptoCipher.encryptJson(
      {
        id: orderDelivery.id,
        transactionId: orderDelivery.transactionId,
      },
      couponTokenExpiry(orderDelivery.expireAt),
    );

    const deliveryHistory = new DeliverySendHistoryEntity();
    deliveryHistory.context = '{}';
    deliveryHistory.isSuccess = true;
    deliveryHistory.target = this.cryptoCipher.encryptDeliveryTarget(decryptedTarget);
    deliveryHistory.deliveryMethod = orderDelivery.deliveryMethod;

    const filePathList = orderDelivery.imagePath ? [orderDelivery.imagePath] : [];
    const title = mapping.sendTitle || product.name;

    if (orderDelivery.deliveryMethod === IOrderSendMethod.ALIM_TALK) {
      await this.deliverySendService.sendAlimTalk(
        orderDelivery,
        decryptedTarget,
        encryptKey,
        title,
        body,
        memo,
        tailText,
        filePathList,
        deliveryHistory,
      );
    } else if (orderDelivery.deliveryMethod === IOrderSendMethod.MMS) {
      await this.deliverySendService.sendSms(
        orderDelivery,
        decryptedTarget,
        encryptKey,
        title,
        body,
        memo,
        tailText,
        filePathList,
        deliveryHistory,
      );
    } else if (orderDelivery.deliveryMethod === IOrderSendMethod.EMAIL) {
      const emailText = tailText ? `${body}\n\n${tailText}` : body;
      await this.deliverySendService.sendEmail(
        orderDelivery,
        decryptedTarget,
        encryptKey,
        title,
        emailText,
        deliveryHistory,
      );
    }

    await this.deliverySendHistoryRepository.save(deliveryHistory);
    return deliveryHistory;
  }

  // ─── 재발송 한도 ────────────────────────────────────────

  private resolveResendMax(account: ExternalApiAccountEntity): number {
    const fallback = Number(process.env.EXTERNAL_API_RESEND_MAX_DEFAULT ?? 3);
    return account.resendMaxCount ?? fallback;
  }

  // ─── 상품 조회 ──────────────────────────────────────────

  // 상품 조회: 매핑모드(externalCustomerId)면 매핑 billing user 기준 할당상품, 미지정이면 default billing(account.user).
  // 주문 생성과 동일 resolver 사용 — 미등록 externalCustomerId → 4003 fail-closed.
  async getProducts(
    account: ExternalApiAccountEntity,
    ctx: ApiRequestContext,
    productCode?: string,
    externalCustomerId?: string,
  ): Promise<ExternalApiResponse<ProductResponseData[]>> {
    const { billingUser } = await this.mappingResolver.resolveBillingTarget(
      ctx.apiApp.id,
      externalCustomerId,
      account.user.id,
    );
    return this.getProductsForBilling(billingUser, productCode);
  }

  // billingUser 기준 상품 조회(add-only, 본문 이동). 단순모드 billingUser=account.user 라 동일.
  async getProductsForBilling(
    billingUser: UserEntity,
    productCode?: string,
  ): Promise<ExternalApiResponse<ProductResponseData[]>> {
    const user = billingUser;
    const isSuperAdmin = user.authority === IUserAuthority.SUPER_ADMIN;

    const qb = this.productRepository
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.brand', 'brand')
      .innerJoin('product.partnerCompany', 'partnerCompany')
      .where('product.useStatus = :useStatus', { useStatus: 'USE' })
      .andWhere('product.type != :ssgType', { ssgType: IProductType.SSG })
      .andWhere('partnerCompany.type != :ssgPartnerType', { ssgPartnerType: IPartnerCompanyType.SSG });

    if (!isSuperAdmin) {
      const assignedIds = await this.getAssignedProductIds(user.id);

      if (assignedIds.length === 0) {
        if (productCode) {
          throw new ExternalApiException('3001', '올바르지 못한 요청입니다');
        }
        return ExternalApiResponse.success([]);
      }

      qb.andWhere('product.id IN (:...assignedIds)', { assignedIds });
    }

    if (productCode) {
      qb.andWhere('product.code = :productCode', { productCode });
    }

    const products = await qb.getMany();

    if (productCode && products.length === 0) {
      throw new ExternalApiException('3001', '올바르지 못한 요청입니다');
    }

    const data: ProductResponseData[] = products.map((p) => ({
      productCode: p.code,
      productName: p.name,
      brandName: p.brand?.nameKorean ?? '',
      price: p.price,
      salePrice: p.price,
      imageUrl: p.imagePath,
      validDays: p.expireDay,
      type: p.type,
      memo: p.memo,
      isCancelable: p.isCancelable,
    }));

    return ExternalApiResponse.success(data);
  }

  // ─── 주문 생성 (3-phase) ────────────────────────────────

  async createOrder(
    account: ExternalApiAccountEntity,
    dto: CreateExternalOrderDto,
    ctx: ApiRequestContext,
  ): Promise<ExternalApiResponse<OrderResponseData>> {
    // 비즈니스 멱등(매핑모드 보조): 동일 (apiApp, externalOrderId) 기존 주문이면 그 응답을 반환.
    // 전송 멱등(Idempotency-Key 헤더)과 직교 — 이건 주문축, 그건 요청축.
    if (dto.externalOrderId) {
      const existing = await this.mappingResolver.findExistingOrderByExternalOrderId(
        ctx.apiApp.id,
        dto.externalOrderId,
      );
      if (existing) {
        return this.buildCreateResponseForExistingOrder(existing);
      }
    }

    let order!: OrderEntity;
    let orderDelivery!: OrderDeliveryEntity;
    try {
      ({ order, orderDelivery } = await this.phaseA_createAndDeduct(account, dto, ctx));
    } catch (error) {
      // 동시 요청 race: DB UNIQUE(api_app_id, external_order_id) 위반 → 기존 주문 멱등 반환(비500).
      if (dto.externalOrderId && this.isDuplicateExternalOrderError(error)) {
        const existing = await this.mappingResolver.findExistingOrderByExternalOrderId(
          ctx.apiApp.id,
          dto.externalOrderId,
        );
        if (existing) {
          return this.buildCreateResponseForExistingOrder(existing);
        }
        throw new ExternalApiException('2005', '요청 처리 중');
      }
      throw error;
    }

    const externalTrId = orderDelivery.externalTrId!;

    try {
      await this.phaseB_issueAndSend(orderDelivery);
    } catch (error) {
      this.logger.error(`[createOrder] Phase B 실패 - externalTrId: ${externalTrId}`, error);
      await this.phaseC_handleFailure(order, orderDelivery, account, error);
      throw translatePartnerError(error, 'issue');
    }

    await this.phaseC_handleSuccess(order, orderDelivery);
    this.logOrderObservability(order, ctx);

    const { validStartDate, validEndDate } = this.resolveValidDates(orderDelivery);

    return ExternalApiResponse.success<OrderResponseData>({
      trId: externalTrId,
      barCode: orderDelivery.barCode || undefined,
      validStartDate,
      validEndDate,
      price: order.sendAmount,
      settleAmount: order.settleAmount,
    });
  }

  // 멱등 응답용: 기존 주문의 최신 orderDelivery 로드(없거나 externalTrId 없으면 2005). 일반/SSG 빌더 공통.
  private async loadExistingOrderDeliveryForResponse(order: OrderEntity): Promise<OrderDeliveryEntity> {
    const orderDelivery = await this.orderDeliveryRepository.findOne({
      where: { orderProductMapping: { order: { id: order.id } } },
      relations: ['orderProductMapping', 'orderProductMapping.order'],
      order: { id: 'DESC' },
    });
    if (!orderDelivery || !orderDelivery.externalTrId) {
      // 비정상(기존 주문에 delivery 없음) — 멱등 보장 불가, 처리 중으로 응답해 재시도 유도.
      throw new ExternalApiException('2005', '요청 처리 중');
    }
    return orderDelivery;
  }

  // 동일 (apiApp, externalOrderId) 기존 주문의 주문생성 응답을 재구성(멱등 반환).
  private async buildCreateResponseForExistingOrder(
    order: OrderEntity,
  ): Promise<ExternalApiResponse<OrderResponseData>> {
    const orderDelivery = await this.loadExistingOrderDeliveryForResponse(order);
    const { validStartDate, validEndDate } = this.resolveValidDates(orderDelivery);
    return ExternalApiResponse.success<OrderResponseData>({
      trId: orderDelivery.externalTrId!,
      barCode: orderDelivery.barCode || undefined,
      validStartDate,
      validEndDate,
      price: order.sendAmount,
      settleAmount: order.settleAmount,
    });
  }

  // order.external_order_id UNIQUE(uk_order_api_app_external_order) 위반 판별(동시성 dup).
  private isDuplicateExternalOrderError(error: unknown): boolean {
    const code =
      (error as { code?: string; driverError?: { code?: string } })?.code ??
      (error as { driverError?: { code?: string } })?.driverError?.code;
    const message = (error as { message?: string })?.message ?? '';
    return code === 'ER_DUP_ENTRY' && message.includes('uk_order_api_app_external_order');
  }

  // ─── Phase A: 주문 생성 + 잔액 차감 ─────────────────────

  @Transactional()
  private async phaseA_createAndDeduct(
    account: ExternalApiAccountEntity,
    dto: CreateExternalOrderDto,
    ctx: ApiRequestContext,
  ) {
    const user = account.user;
    // 3계층 매핑모드 resolve: externalCustomerId → billing user(+company), clientUserId.
    // 단순모드(미지정/빈) → billingUser=account.user, clientUserId=null (기존 경로 비트동일).
    const { billingUser, clientUserId, externalCustomerId } = await this.mappingResolver.resolveBillingTarget(
      ctx.apiApp.id,
      dto.externalCustomerId,
      account.user.id,
    );

    // 독립 쿼리(상품 조회 / 할당 상품 ID / 직전 주문 코드)는 병렬화하여 round-trip 절약
    const [product, assignedIds, prevOrder] = await Promise.all([
      this.productRepository.findOne({
        where: { code: dto.productCode, useStatus: IProductUseStatus.USE },
        relations: ['partnerCompany', 'brand'],
      }),
      this.getAssignedProductIdsForBilling(billingUser.id),
      this.orderRepository.findOne({
        where: { code: Like(`${OrderPrefixCode}%`) },
        order: { code: 'DESC' },
        withDeleted: true,
      }),
    ]);

    if (!product) {
      throw new ExternalApiException('3001', '올바르지 못한 요청입니다');
    }
    if (!assignedIds.includes(product.id)) {
      throw new ExternalApiException('3001', '올바르지 못한 요청입니다');
    }

    const sendAmount = product.price;
    const { fee, priceAdjustment, settleAmount, cardSurchargeApplied } = await this.computeSettlementForBilling(
      billingUser,
      product,
      sendAmount,
      { cardSurchargeApplied: this.resolveCardSurchargeAppliedForUser(billingUser) },
    );

    // 발신번호 SoT 검증(차감 전, flag gating). 차감은 아래 order 그래프 저장 후 wallet/legacy 분기에서 수행.
    if (process.env.FROM_PHONE_SOT_ENFORCE === 'true') {
      await this.orderFromService.assertApprovedPhones(billingUser.id, [
        { sendMethod: dto.deliveryMethod as IOrderSendMethod, fromPhoneNumber: dto.senderPhone ?? null },
      ]);
    }

    const newCode = CreateCode(prevOrder?.code ?? null, OrderPrefixCode, OrderDigitNumber);

    const order = this.orderRepository.create({
      userId: user.id,
      code: newCode,
      type: IOrderType.EXTERNAL,
      status: IOrderStatus.DELIVERY_REQUEST,
      eventName: `외부주문`,
      registerAt: new Date(),
      sendAmount,
      settleAmount,
      cardSurchargeApplied,
      isNewBillingFlow: false,
      isSettleBalance: true,
      isSettleComplete: false,
      clientUserId,
      // PR2a: 외부API 호출주체 적재 (단순모드 = credential→app).
      apiAppId: ctx.apiApp.id,
      apiCredentialId: ctx.apiCredential.id,
      externalOrderId: dto.externalOrderId?.trim() || null,
      externalCustomerId,
      ...buildOrderUserSnapshot(user),
      ...buildOrderClientUserSnapshot(clientUserId != null ? billingUser : null),
      ...buildOrderOperationUserSnapshot(null),
    });
    await this.orderRepository.save(order);

    const mapping = this.orderProductMappingRepository.create({
      orderId: order.id,
      productId: product.id,
      amount: 1,
      sendContent: dto.message || '',
      sendTitle: dto.title || product.name,
      fromPhoneNumber: dto.senderPhone,
      sendMethod: dto.deliveryMethod as IOrderSendMethod,
      fee,
      priceAdjustment,
      topImagePath: '',
      midImagePath: '',
      ...buildLineProductSnapshot(product),
    });
    await this.orderProductMappingRepository.save(mapping);

    const orderDelivery = this.orderDeliveryRepository.create({
      orderProductMappingId: mapping.id,
      status: IOrderDeliveryStatus.WAIT,
      deliveryMethod: dto.deliveryMethod as IOrderSendMethod,
      deliveryTarget: this.cryptoCipher.encryptDeliveryTarget(dto.recipientPhone),
      originalDeliveryTarget: this.cryptoCipher.encryptDeliveryTarget(dto.recipientPhone),
      sendRequestAt: new Date(),
    });
    await this.orderDeliveryRepository.save(orderDelivery);

    orderDelivery.transactionId = CreateApiTransactionId(order.id, orderDelivery.id);
    orderDelivery.externalTrId = await this.saveTransactionIds(orderDelivery.id, orderDelivery.transactionId);

    mapping.product = product;
    mapping.order = order;
    order.user = user;
    orderDelivery.orderProductMapping = mapping;

    // R1: 차감은 order+mapping+orderDelivery 저장 이후. WALLET 모드면 wallet allocation,
    // 그 외(LEGACY/SHADOW)는 기존 raw deductBalance 유지(회귀 0).
    if (this.walletCutoverConfig.pr2DeliveryLifecycleMode === WalletCutoverMode.WALLET) {
      // R6: builder 가 읽는 관계그래프를 in-memory 로 구성.
      mapping.orderDeliveries = [orderDelivery];
      order.orderProductMappings = [mapping];
      await this.deductViaWallet(billingUser, order, settleAmount);
    } else {
      // 매핑모드(clientUserId≠null)는 WALLET cutover 전제. 레거시 차감경로 진입 시 fail-closed
      // (매핑 billing 이 아닌 default 로 차감되는 money drift 방지).
      if (clientUserId != null) {
        throw new ExternalApiException('9999', '시스템 오류', '매핑모드는 WALLET cutover 전제입니다');
      }
      await this.deductBalance(billingUser, settleAmount);
    }

    return { order, orderDelivery, mapping, product };
  }

  // ─── Phase B: 쿠폰 발행 + 발송 (트랜잭션 없음) ──────────

  private async phaseB_issueAndSend(orderDelivery: OrderDeliveryEntity, ssgEvent: SsgEventEntity | null = null) {
    const mapping = orderDelivery.orderProductMapping;
    const product = mapping.product;

    await this.partnerCompanyExternService.issue(orderDelivery, ssgEvent);

    // SSG는 issue() 내부에서 expireAt을 설정하고, 그 외 협력사는 설정하지 않으므로
    // External API에서 직접 산출. partnerCompany.validityStartsNextDay 정책을 따른다.
    if (!orderDelivery.expireAt && product.expireDay) {
      const expireDays = resolveExpireDays(
        mapping.galaxiaDuration ?? product.galaxiaDuration,
        product.expireDay,
        product.partnerCompany?.validityStartsNextDay,
      );
      orderDelivery.expireAt = addDays(new Date(), expireDays);
    }

    if (orderDelivery.barCode) {
      const expireDate = orderDelivery.expireAt ? dayjs(orderDelivery.expireAt).format('YYYY. MM. DD') : null;
      const { path } = await DeliveryCreateCouponImage(
        product.imagePath,
        product.name,
        orderDelivery.barCode,
        product.brand?.nameKorean || '',
        expireDate,
        mapping.topImagePath || '',
        mapping.midImagePath || '',
        product.type,
      );
      orderDelivery.imagePath = path;
    }

    const deliveryHistory = await this.dispatchSend(orderDelivery);

    if (!deliveryHistory.isSuccess) {
      throw new Error('발송 실패');
    }

    return { orderDelivery, deliveryHistory };
  }

  // ─── Phase C: 성공 상태 업데이트 ─────────────────────────

  @Transactional()
  private async phaseC_handleSuccess(order: OrderEntity, orderDelivery: OrderDeliveryEntity) {
    if (!orderDelivery.actualSendAt) {
      orderDelivery.actualSendAt = new Date();
    }
    await this.orderDeliveryRepository.save(orderDelivery);

    order.status = IOrderStatus.DELIVERY_COMPLETE;
    await this.orderRepository.save(order);
  }

  // ─── Phase C: 실패 처리 + 환불 ──────────────────────────

  @Transactional()
  private async phaseC_handleFailure(
    order: OrderEntity,
    orderDelivery: OrderDeliveryEntity,
    account: ExternalApiAccountEntity,
    error: any,
  ) {
    orderDelivery.status = IOrderDeliveryStatus.FAIL;
    orderDelivery.apiErrorMessage = error?.message?.substring(0, 500) ?? null;
    if (!orderDelivery.failedAt) {
      orderDelivery.failedAt = new Date();
    }
    await this.orderDeliveryRepository.save(orderDelivery);

    order.status = IOrderStatus.DELIVERY_CANCEL;
    await this.orderRepository.save(order);

    // 매핑모드: 환불/회사모드/ledger claim 을 billing user 기준으로 (단순모드는 account.user=billingUser 동일).
    const billingUser = await this.loadOrderBillingUser(order, account.user);

    const isCompanyMode = billingUser.company?.balanceManagementType === 'COMPANY';
    const isSsg = order.type === IOrderType.SSG && !!orderDelivery.ssgEventId;
    const isWalletManaged = await this.walletManagedPredicate.isWalletManaged(order.id, this.dataSource.manager);

    // R7-A: claim 멱등 게이트 (내부 batch 패턴).
    //  - legacy: 중복이면 이전 처리 성공이므로 short-circuit return.
    //  - wallet: claim 만 commit 되고 wallet 환불이 실패한 retry 케이스 가능 → 흡수 후 wallet 재시도 진행.
    try {
      await this.refundLedgerService.claim({
        orderDeliveryId: orderDelivery.id,
        userId: billingUser.id,
        refundAmount: order.settleAmount,
        restoreType: isCompanyMode ? 'COMPANY_BALANCE' : 'BALANCE',
        isSettleComplete: order.isSettleComplete,
        isSettleBalance: order.isSettleBalance,
        sourcePath: 'EXTERNAL_FAIL',
        operatorUserId: null,
        memo: `외부 API 발송 실패 환불 (주문번호: ${order.id})`,
        // SSG 주문은 ledger.ssg_balance_settled 를 false 로 시작 → resolver 가 RESTORED/SKIPPED_CONFIRMED
        // 반환 시 markSsgSettled 로 true 갱신. DEFERRED 면 false 유지 → 다음 재발송 가드 차단.
        ssgPending: isSsg,
      });
    } catch (claimError) {
      if (claimError instanceof BadRequestException) {
        if (isWalletManaged) {
          this.logger.warn(
            `[EXTERNAL_FAIL] claim 중복 — wallet path 멱등 재시도 진행. orderDelivery.id: ${orderDelivery.id}`,
          );
        } else {
          this.logger.warn(`[EXTERNAL_FAIL] 환불 중복 차단 (정상, legacy) - orderDelivery.id: ${orderDelivery.id}`);
          return;
        }
      } else {
        throw claimError;
      }
    }

    // plans/ssg-balance-refactor.md PR3.C — 외부 API SSG 주문도 Phase B 실패 시 SSG 행사 잔액 분기 적용.
    // HIGH-2: 실시간 경로도 sweep 과 동일한 단일 CAS 게이트(recoverWithLease)를 경유한다.
    //   - resolver 직접 호출(우회) 시 sweep 과 race → 별도 게이트 2개. recoverWithLease 가 token-fenced lease 로 단일화.
    //   - CAS WHERE(settled=false AND lease free)가 "이미 settled/타 actor 진행중"을 거른다 → 별도 isSsgSettled 선체크 불필요.
    //   - claim 중복(wallet retry) 케이스도 settled=false 면 CAS 가 claim 해 재실행, settled=true 면 SKIPPED_NO_CLAIM.
    if (isSsg) {
      const result = await this.ssgRecoveryService.recoverWithLease(
        orderDelivery.id,
        orderDelivery.ssgEventId!,
        order.id,
        order.sendAmount,
      );
      if (result === SsgRecoveryResult.DEFERRED) {
        this.logger.error(
          `[EXTERNAL_FAIL] SSG 잔액 보정 DEFERRED — ledger.ssg_balance_settled=false 유지. 운영 점검 필요. orderDelivery.id: ${orderDelivery.id}`,
        );
      }
    }

    // R2: 환불 wallet 분기. wallet-managed 면 풀 기반 환불 + R4 차감 mirror 역복원,
    // 그 외(LEGACY/SHADOW)는 기존 raw refundBalance 유지(회귀 0).
    if (isWalletManaged) {
      await this.refundViaWallet(
        billingUser,
        order,
        orderDelivery,
        OrderPaymentRefundEventType.FAIL_REFUND,
        'fail_refund',
      );
    } else {
      await this.refundBalance(billingUser, order.settleAmount);
    }
  }

  // ─── 주문 상태 조회 ─────────────────────────────────────

  async getOrderStatus(
    account: ExternalApiAccountEntity,
    trId: string,
    ctx: ApiRequestContext,
  ): Promise<ExternalApiResponse<OrderStatusResponseData>> {
    const orderDelivery = await this.findOrderDeliveryByTrId(account, trId, ctx);
    const mapping = orderDelivery.orderProductMapping;
    const product = mapping?.product;
    const order = mapping?.order;
    const price = product?.price ?? 0;
    const settleAmount = order?.settleAmount ?? 0;
    const { validStartDate, validEndDate } = this.resolveValidDates(orderDelivery);

    return ExternalApiResponse.success<OrderStatusResponseData>({
      trId: orderDelivery.externalTrId!,
      couponStatus: this.toExternalCouponStatus(orderDelivery.couponStatus),
      deliveryStatus: this.toExternalDeliveryStatus(orderDelivery),
      barCode: orderDelivery.barCode || undefined,
      validStartDate,
      validEndDate,
      price,
      settleAmount,
    });
  }

  // ─── SSG 주문 상태 조회 ─────────────────────────────────

  async getSsgOrderStatus(
    account: ExternalApiAccountEntity,
    trId: string,
    ctx: ApiRequestContext,
  ): Promise<ExternalApiResponse<SsgOrderStatusResponseData>> {
    const orderDelivery = await this.findOrderDeliveryByTrId(account, trId, ctx);
    const order = orderDelivery.orderProductMapping?.order;
    const price = order?.sendAmount ?? 0;
    const settleAmount = order?.settleAmount ?? 0;
    const { validStartDate, validEndDate } = this.resolveValidDates(orderDelivery);

    return ExternalApiResponse.success<SsgOrderStatusResponseData>({
      trId: orderDelivery.externalTrId!,
      couponStatus: this.toExternalCouponStatus(orderDelivery.couponStatus),
      deliveryStatus: this.toExternalDeliveryStatus(orderDelivery),
      barCode: orderDelivery.barCode || undefined,
      personalCode: orderDelivery.personalCode || undefined,
      validStartDate,
      validEndDate,
      price,
      settleAmount,
    });
  }

  // ─── 주문 취소 ──────────────────────────────────────────

  async cancelOrder(
    account: ExternalApiAccountEntity,
    trId: string,
    ctx: ApiRequestContext,
  ): Promise<ExternalApiResponse> {
    const orderDelivery = await this.findOrderDeliveryByTrId(account, trId, ctx);
    const mapping = orderDelivery.orderProductMapping;
    const order = mapping.order;
    const product = mapping.product;

    if (order.type === IOrderType.SSG) {
      throw new ExternalApiException('3009', '신세계 상품권은 폐기할 수 없습니다');
    }

    if (
      orderDelivery.status === IOrderDeliveryStatus.CANCEL ||
      orderDelivery.couponStatus === OrderDeliveryCouponStatus.CANCEL ||
      orderDelivery.couponStatus === OrderDeliveryCouponStatus.REFUND_CANCEL
    ) {
      throw new ExternalApiException('3005', '이미 폐기/취소된 주문');
    }

    if (orderDelivery.couponStatus === OrderDeliveryCouponStatus.USED) {
      throw new ExternalApiException('3006', '이미 사용된 쿠폰은 취소 불가');
    }

    if (orderDelivery.expireAt && orderDelivery.expireAt.getTime() < Date.now()) {
      throw new ExternalApiException('3007', '만료된 쿠폰');
    }

    if (product?.isCancelable === false) {
      throw new ExternalApiException('3009', '취소 불가 상품');
    }

    if (orderDelivery.barCode && product?.partnerCompany) {
      try {
        await this.partnerCompanyExternService.cancelByExternalApi(orderDelivery);
      } catch (error) {
        this.logger.error(`[cancelOrder] 쿠폰 취소 실패 - trId: ${trId}`, error);
        throw translatePartnerError(error, 'cancel');
      }
    }

    await this.processCancelRefund(order, orderDelivery, account);

    return ExternalApiResponse.success();
  }

  @Transactional()
  private async processCancelRefund(
    order: OrderEntity,
    orderDelivery: OrderDeliveryEntity,
    account: ExternalApiAccountEntity,
  ) {
    orderDelivery.status = IOrderDeliveryStatus.CANCEL;
    orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;
    orderDelivery.discardedAt = new Date();
    await this.orderDeliveryRepository.save(orderDelivery);

    order.status = IOrderStatus.DELIVERY_CANCEL;
    await this.orderRepository.save(order);

    // 매핑모드: 취소 환불/회사모드/ledger claim 을 billing user 기준으로 (단순모드 동일).
    const billingUser = await this.loadOrderBillingUser(order, account.user);

    const isCompanyMode = billingUser.company?.balanceManagementType === 'COMPANY';
    const isWalletManaged = await this.walletManagedPredicate.isWalletManaged(order.id, this.dataSource.manager);
    await this.refundLedgerService.claim({
      orderDeliveryId: orderDelivery.id,
      userId: billingUser.id,
      refundAmount: order.settleAmount,
      restoreType: isCompanyMode ? 'COMPANY_BALANCE' : 'BALANCE',
      isSettleComplete: order.isSettleComplete,
      isSettleBalance: order.isSettleBalance,
      sourcePath: 'EXTERNAL_CANCEL',
      operatorUserId: null,
      memo: `외부 API 취소 환불 (주문번호: ${order.id})`,
    });

    // R2: 취소 환불 wallet 분기. cancel 경로는 SSG 차단(cancelOrder:606)이라 SSG resolver 불필요.
    if (isWalletManaged) {
      await this.refundViaWallet(
        billingUser,
        order,
        orderDelivery,
        OrderPaymentRefundEventType.DISCARD_REFUND,
        'discard_refund',
      );
    } else {
      await this.refundBalance(billingUser, order.settleAmount);
    }
  }

  // ─── 재발송 ─────────────────────────────────────────────

  async resendOrder(
    account: ExternalApiAccountEntity,
    trId: string,
    ctx: ApiRequestContext,
  ): Promise<ExternalApiResponse> {
    const orderDelivery = await this.findOrderDeliveryByTrId(account, trId, ctx);
    const order = orderDelivery.orderProductMapping?.order;

    // R3: 재발송은 발송 성공(DELIVERY_COMPLETE) 주문만 허용. 실패/취소(DELIVERY_CANCEL)는 거절.
    // 폐기/취소된 쿠폰(couponStatus CANCEL/REFUND_CANCEL)도 거절. cancelOrder 가드와 대칭.
    if (order?.status !== IOrderStatus.DELIVERY_COMPLETE) {
      throw new ExternalApiException('3005', '발송 완료된 주문만 재발송 가능');
    }
    if (
      orderDelivery.couponStatus === OrderDeliveryCouponStatus.CANCEL ||
      orderDelivery.couponStatus === OrderDeliveryCouponStatus.REFUND_CANCEL
    ) {
      throw new ExternalApiException('3005', '폐기/취소된 쿠폰은 재발송 불가');
    }

    if (!orderDelivery.barCode) {
      throw new ExternalApiException('3004', '발행된 쿠폰이 없어 재발송 불가');
    }

    const max = this.resolveResendMax(account);

    // ─ Atomic slot claim ─
    // 동시 이중 발송(발송 비용 중복)과 resendCount 손실 race 를 차단하기 위해,
    // 외부 발송 전에 DB 에서 원자적으로 슬롯을 선점한다 (read-then-write save 금지).
    // WHERE 에 couponStatus 가드를 포함해 SELECT~UPDATE 사이의 취소/폐기 race 도 닫는다.
    const claim = await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({ resendCount: () => 'resend_count + 1' })
      .where('id = :id', { id: orderDelivery.id })
      .andWhere('resend_count < :max', { max })
      .andWhere('coupon_status NOT IN (:...blocked)', {
        blocked: [OrderDeliveryCouponStatus.CANCEL, OrderDeliveryCouponStatus.REFUND_CANCEL],
      })
      .execute();

    if (!claim.affected) {
      // 한도 도달 또는 직전 취소/폐기. 최신 상태로 정확히 분기.
      const fresh = await this.orderDeliveryRepository.findOne({
        where: { id: orderDelivery.id },
        select: ['resendCount', 'couponStatus'],
      });
      if (
        fresh?.couponStatus === OrderDeliveryCouponStatus.CANCEL ||
        fresh?.couponStatus === OrderDeliveryCouponStatus.REFUND_CANCEL
      ) {
        throw new ExternalApiException('3005', '폐기/취소된 쿠폰은 재발송 불가');
      }
      throw new ExternalApiException('3008', `재발송 횟수 초과 (${fresh?.resendCount ?? max}/${max})`);
    }

    // 슬롯 선점 후 외부 발송. 실패(throw 또는 isSuccess=false)하면 선점한 슬롯을 되돌린다
    // (현행 정책: 성공만 카운트). 단일 catch 로 롤백 경로를 통일한다.
    try {
      const history = await this.dispatchSend(orderDelivery);
      if (!history.isSuccess) {
        throw new ExternalApiException('3003', '재발송 실패');
      }
    } catch (error) {
      await this.releaseResendSlot(orderDelivery.id);
      throw error;
    }

    // 성공: resendCount 는 이미 DB 에서 +1 됨(save 로 stale 값 덮지 말 것).
    // dispatchSend 가 in-memory 로 갱신한 발송 상태만 targeted update.
    await this.orderDeliveryRepository.update(
      { id: orderDelivery.id },
      {
        resendAt: new Date(),
        status: orderDelivery.status,
        actualSendAt: orderDelivery.actualSendAt,
      },
    );

    return ExternalApiResponse.success();
  }

  /** 재발송 슬롯 롤백 — 발송 실패 시 선점한 슬롯 1개 반납 (음수 방지). */
  private async releaseResendSlot(orderDeliveryId: number): Promise<void> {
    await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({ resendCount: () => 'GREATEST(resend_count - 1, 0)' })
      .where('id = :id', { id: orderDeliveryId })
      .execute();
  }

  // ─── SSG 주문 생성 ──────────────────────────────────────

  async createSsgOrder(
    account: ExternalApiAccountEntity,
    dto: CreateExternalSsgOrderDto,
    ctx: ApiRequestContext,
  ): Promise<ExternalApiResponse<SsgOrderResponseData>> {
    // SSG 게이트 SoT = api_app.ssgEnabled (키회전 보존, A8/S4). account.ssgEnabled 아님.
    if (!ctx.apiApp.ssgEnabled) {
      throw new ExternalApiException('1005', 'SSG 미승인 계정');
    }

    // 비즈니스 멱등(SSG): 동일 (apiApp, externalOrderId) 기존 주문이면 그 응답 반환.
    if (dto.externalOrderId) {
      const existing = await this.mappingResolver.findExistingOrderByExternalOrderId(
        ctx.apiApp.id,
        dto.externalOrderId,
      );
      if (existing) {
        return this.buildSsgCreateResponseForExistingOrder(existing);
      }
    }

    let order!: OrderEntity;
    let orderDelivery!: OrderDeliveryEntity;
    let ssgEvent!: SsgEventEntity;
    try {
      ({ order, orderDelivery, ssgEvent } = await this.phaseA_createSsgAndDeduct(account, dto, ctx));
    } catch (error) {
      if (dto.externalOrderId && this.isDuplicateExternalOrderError(error)) {
        const existing = await this.mappingResolver.findExistingOrderByExternalOrderId(
          ctx.apiApp.id,
          dto.externalOrderId,
        );
        if (existing) {
          return this.buildSsgCreateResponseForExistingOrder(existing);
        }
        throw new ExternalApiException('2005', '요청 처리 중');
      }
      throw error;
    }

    const externalTrId = orderDelivery.externalTrId!;

    try {
      await this.phaseB_issueAndSend(orderDelivery, ssgEvent);
    } catch (error) {
      this.logger.error(`[createSsgOrder] Phase B 실패 - externalTrId: ${externalTrId}`, error);
      await this.phaseC_handleFailure(order, orderDelivery, account, error);
      throw translatePartnerError(error, 'issue');
    }

    await this.phaseC_handleSuccess(order, orderDelivery);
    this.logOrderObservability(order, ctx);

    const { validStartDate, validEndDate } = this.resolveValidDates(orderDelivery);

    return ExternalApiResponse.success<SsgOrderResponseData>({
      trId: externalTrId,
      barCode: orderDelivery.barCode || undefined,
      personalCode: orderDelivery.personalCode || undefined,
      validStartDate,
      validEndDate,
      price: order.sendAmount,
      settleAmount: order.settleAmount,
    });
  }

  // 동일 (apiApp, externalOrderId) 기존 SSG 주문의 주문생성 응답을 재구성(멱등 반환, personalCode 포함).
  private async buildSsgCreateResponseForExistingOrder(
    order: OrderEntity,
  ): Promise<ExternalApiResponse<SsgOrderResponseData>> {
    const orderDelivery = await this.loadExistingOrderDeliveryForResponse(order);
    const { validStartDate, validEndDate } = this.resolveValidDates(orderDelivery);
    return ExternalApiResponse.success<SsgOrderResponseData>({
      trId: orderDelivery.externalTrId!,
      barCode: orderDelivery.barCode || undefined,
      personalCode: orderDelivery.personalCode || undefined,
      validStartDate,
      validEndDate,
      price: order.sendAmount,
      settleAmount: order.settleAmount,
    });
  }

  @Transactional()
  private async phaseA_createSsgAndDeduct(
    account: ExternalApiAccountEntity,
    dto: CreateExternalSsgOrderDto,
    ctx: ApiRequestContext,
  ) {
    const user = account.user;
    // 3계층 매핑모드 resolve (SSG): externalCustomerId → billing user(+company), clientUserId.
    // 단순모드(미지정/빈) → billingUser=account.user, clientUserId=null (기존 SSG 경로 비트동일).
    const { billingUser, clientUserId, externalCustomerId } = await this.mappingResolver.resolveBillingTarget(
      ctx.apiApp.id,
      dto.externalCustomerId,
      account.user.id,
    );
    const sendAmount = dto.amount;

    // 요청 금액과 일치하는 SSG 상품을 확정(없으면 템플릿으로 생성).
    // 내부 admin /order/ssg 흐름과 동일한 resolver를 사용해 sendAmount === product.price 보장.
    const product = await this.productService.findOrCreateSsgProductByPrice(sendAmount).catch(() => {
      throw new ExternalApiException('3001', 'SSG 상품 없음');
    });

    const prevOrder = await this.orderRepository.findOne({
      where: { code: Like(`${OrderPrefixCode}%`) },
      order: { code: 'DESC' },
      withDeleted: true,
    });

    // SSG 이벤트는 sendAmount(정가) 기준으로 매칭/차감 (할인/할증/카드할증과 무관)
    const ssgEvent = await this.ssgEventService.selectEventForOrder(sendAmount, product.expireDay);
    if (!ssgEvent) {
      throw new ExternalApiException('3002', 'SSG 이벤트 잔액 부족');
    }

    const { fee, priceAdjustment, settleAmount, cardSurchargeApplied } = await this.computeSettlementForBilling(
      billingUser,
      product,
      sendAmount,
      { cardSurchargeApplied: this.resolveCardSurchargeAppliedForUser(billingUser) },
    );

    // senderPhone 미지정 SSG 알림톡 → 자사 대표번호로 확정 (검증/저장 동일값)
    const effectiveSenderPhone = dto.senderPhone ?? systemFromPhoneNumber;

    // 발신번호 SoT 검증(차감 전, flag gating). 차감은 아래 order 그래프 저장 후 wallet/legacy 분기에서 수행.
    if (process.env.FROM_PHONE_SOT_ENFORCE === 'true') {
      await this.orderFromService.assertApprovedPhones(billingUser.id, [
        { sendMethod: IOrderSendMethod.ALIM_TALK, fromPhoneNumber: effectiveSenderPhone },
      ]);
    }

    const newCode = CreateCode(prevOrder?.code ?? null, OrderPrefixCode, OrderDigitNumber);

    const order = this.orderRepository.create({
      userId: user.id,
      code: newCode,
      type: IOrderType.SSG,
      status: IOrderStatus.DELIVERY_REQUEST,
      eventName: `외부SSG주문`,
      registerAt: new Date(),
      sendAmount,
      settleAmount,
      cardSurchargeApplied,
      isNewBillingFlow: false,
      isSettleBalance: true,
      isSettleComplete: false,
      ssgEventId: ssgEvent.id,
      clientUserId,
      // PR2a: 외부API 호출주체 적재 (단순모드 = credential→app).
      apiAppId: ctx.apiApp.id,
      apiCredentialId: ctx.apiCredential.id,
      externalOrderId: dto.externalOrderId?.trim() || null,
      externalCustomerId,
      ...buildOrderUserSnapshot(user),
      ...buildOrderClientUserSnapshot(clientUserId != null ? billingUser : null),
      ...buildOrderOperationUserSnapshot(null),
    });
    await this.orderRepository.save(order);

    const mapping = this.orderProductMappingRepository.create({
      orderId: order.id,
      productId: product.id,
      amount: 1,
      sendContent: dto.message || '',
      sendTitle: product.name,
      fromPhoneNumber: effectiveSenderPhone,
      sendMethod: IOrderSendMethod.ALIM_TALK,
      fee,
      priceAdjustment,
      topImagePath: '',
      midImagePath: '',
      ...buildLineProductSnapshot(product),
    });
    await this.orderProductMappingRepository.save(mapping);

    const orderDelivery = this.orderDeliveryRepository.create({
      orderProductMappingId: mapping.id,
      status: IOrderDeliveryStatus.WAIT,
      deliveryMethod: IOrderSendMethod.ALIM_TALK,
      deliveryTarget: this.cryptoCipher.encryptDeliveryTarget(dto.recipientPhone),
      originalDeliveryTarget: this.cryptoCipher.encryptDeliveryTarget(dto.recipientPhone),
      sendRequestAt: new Date(),
      ssgEventId: ssgEvent.id,
    });
    await this.orderDeliveryRepository.save(orderDelivery);

    orderDelivery.transactionId = CreateApiTransactionId(order.id, orderDelivery.id);
    orderDelivery.externalTrId = await this.saveTransactionIds(orderDelivery.id, orderDelivery.transactionId);

    // SSG 행사잔액(협력사측) 차감은 wallet(자사 정산분)과 독립 — 그대로 유지.
    await this.ssgEventService.deductEventBalance(ssgEvent.id, sendAmount, order.id, false);

    mapping.product = product;
    mapping.order = order;
    order.user = user;
    orderDelivery.orderProductMapping = mapping;

    // R1: account 정산분 차감은 저장 이후. WALLET 모드면 wallet allocation, 그 외 raw deductBalance.
    if (this.walletCutoverConfig.pr2DeliveryLifecycleMode === WalletCutoverMode.WALLET) {
      // R6: builder 관계그래프 in-memory 구성.
      mapping.orderDeliveries = [orderDelivery];
      order.orderProductMappings = [mapping];
      await this.deductViaWallet(billingUser, order, settleAmount);
    } else {
      // 매핑모드(clientUserId≠null)는 WALLET cutover 전제. 레거시 차감경로 진입 시 fail-closed.
      if (clientUserId != null) {
        throw new ExternalApiException('9999', '시스템 오류', '매핑모드는 WALLET cutover 전제입니다');
      }
      await this.deductBalance(billingUser, settleAmount);
    }

    return { order, orderDelivery, mapping, product, ssgEvent };
  }

  // ─── 공통 유틸 ──────────────────────────────────────────

  /**
   * 내부 쿠폰 상태를 외부 노출용으로 축약.
   * 고객사는 발행/폐기 두 상태만 알면 충분하므로 USED/EXPIRED/REFUND_CANCEL은 ISSUED로 합친다.
   * (REFUND_CANCEL은 고객사의 고객과 자사 간 정산 결과로, 고객사 입장에서는 발행된 쿠폰으로 본다.)
   */
  private toExternalCouponStatus(status: OrderDeliveryCouponStatus): ExternalCouponStatus {
    return status === OrderDeliveryCouponStatus.CANCEL ? ExternalCouponStatus.DISCARDED : ExternalCouponStatus.ISSUED;
  }

  /**
   * 내부 발송 상태를 외부 노출용 성공/실패로 축약.
   * actualSendAt 이 찍혀 있으면(알림톡/SMS 대체 전송 성공 포함) 발송 성공으로 본다.
   * 명시적 실패(FAIL/FAIL_SMS)이거나 미발송이면 실패.
   */
  private toExternalDeliveryStatus(orderDelivery: OrderDeliveryEntity): ExternalDeliveryStatus {
    if (orderDelivery.status === IOrderDeliveryStatus.FAIL || orderDelivery.status === IOrderDeliveryStatus.FAIL_SMS) {
      return ExternalDeliveryStatus.FAIL;
    }
    return orderDelivery.actualSendAt ? ExternalDeliveryStatus.SUCCESS : ExternalDeliveryStatus.FAIL;
  }

  /**
   * partnerCompany.validityStartsNextDay 기반 응답 유효기간 산출.
   * - true(익일 시작): 시작일 = sendRequestAt + 1
   * - false(당일 포함): 시작일 = sendRequestAt
   * 종료일은 이미 issue() 시점에 산출된 expireAt을 그대로 사용.
   */
  private resolveValidDates(orderDelivery: OrderDeliveryEntity): { validStartDate?: string; validEndDate?: string } {
    if (!orderDelivery.expireAt) {
      return { validStartDate: undefined, validEndDate: undefined };
    }
    const partnerCompany = orderDelivery.orderProductMapping?.product?.partnerCompany;
    const startsNextDay = partnerCompany?.validityStartsNextDay ?? true;
    const base = orderDelivery.sendRequestAt ?? new Date();
    const start = startsNextDay ? dayjs(base).add(1, 'day') : dayjs(base);
    return {
      validStartDate: start.format('YYYY-MM-DD'),
      validEndDate: dayjs(orderDelivery.expireAt).format('YYYY-MM-DD'),
    };
  }

  private async findOrderDeliveryByTrId(
    account: ExternalApiAccountEntity,
    trId: string,
    ctx: ApiRequestContext,
  ): Promise<OrderDeliveryEntity> {
    const orderDelivery = await this.orderDeliveryRepository.findOne({
      where: { externalTrId: trId },
      relations: [
        'orderProductMapping',
        'orderProductMapping.order',
        'orderProductMapping.product',
        'orderProductMapping.product.partnerCompany',
        'orderProductMapping.product.brand',
      ],
    });

    if (!orderDelivery) {
      throw new ExternalApiException('4001', '주문을 찾을 수 없음');
    }

    const order = orderDelivery.orderProductMapping?.order;
    if (!order) {
      throw new ExternalApiException('4002', '주문에 대한 접근 권한 없음');
    }
    // PR2 소유권: apiAppId 기준 3분기(공통 헬퍼로 추출).
    this.assertOrderOwnership(order, account, ctx);

    return orderDelivery;
  }

  // 외부 API 주문 소유권 검사(apiAppId 기준, PR2). 모든 trId 기반 조회/상태/취소/재발송이 경유한다.
  //   1) order.apiAppId 적재(신규 주문, 단순+매핑 공통) → 호출 apiApp 과 일치해야 함(불일치 4002).
  //   2) apiAppId 미적재 + clientUserId null → 레거시 단순모드 주문, default_billing_user 기준 폴백.
  //   3) apiAppId 미적재 + clientUserId≠null → 매핑모드인데 호출주체 미적재 = 불변식 위반, 거절.
  private assertOrderOwnership(
    order: Pick<OrderEntity, 'apiAppId' | 'clientUserId' | 'userId'>,
    account: ExternalApiAccountEntity,
    ctx: ApiRequestContext,
  ): void {
    // bigint 비교는 String()으로 통일.
    const callerApiAppId = String(ctx.apiApp.id);
    if (order.apiAppId != null) {
      if (String(order.apiAppId) !== callerApiAppId) {
        throw new ExternalApiException('4002', '주문에 대한 접근 권한 없음');
      }
    } else if (order.clientUserId == null) {
      if (order.userId !== account.user.id) {
        throw new ExternalApiException('4002', '주문에 대한 접근 권한 없음');
      }
    } else {
      throw new ExternalApiException('4002', '주문에 대한 접근 권한 없음');
    }
  }

  /**
   * transactionId + externalTrId(ULID) 한 번에 저장. ULID unique 제약 위반 시 재생성 후 retry.
   */
  private async saveTransactionIds(orderDeliveryId: number, transactionId: string): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const externalTrId = ulid();
      try {
        await this.orderDeliveryRepository.update(orderDeliveryId, { transactionId, externalTrId });
        return externalTrId;
      } catch (error) {
        if (error?.code === 'ER_DUP_ENTRY' && attempt < 2) {
          this.logger.warn(`[saveTransactionIds] ULID 중복 발생, 재시도 (${attempt + 1}/3)`);
          continue;
        }
        throw error;
      }
    }
    throw new Error('externalTrId 생성 실패');
  }
}
