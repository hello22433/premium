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
  OrderResponseData,
  SsgOrderResponseData,
  OrderStatusResponseData,
  SsgOrderStatusResponseData,
  ProductResponseData,
} from '../api/dto/external.api.response.dto';
import { CreateExternalOrderDto, CreateExternalSsgOrderDto } from '../api/dto/external.api.request.dto';

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
import {
  OrderDeliveryAttemptEntity,
  OrderDeliveryAttemptType,
} from '../../entity/order.delivery.attempt.entity';

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
  ) {}

  // ─── 잔액 헬퍼 ──────────────────────────────────────────
  // 잔액 차감 위치는 user.company.balanceManagementType으로 분기.
  //   COMPANY → user_company.balance (회사 단위 정산)
  //   그 외(PERSONAL) → user.balance (계정 단위 정산)

  private async deductBalance(account: ExternalApiAccountEntity, price: number): Promise<void> {
    const user = account.user;
    const isCompany = user.company?.balanceManagementType === 'COMPANY';
    const result = isCompany
      ? await this.dataSource.query(
          'UPDATE user_company SET balance = balance - ? WHERE id = ? AND balance >= ?',
          [price, user.companyId, price],
        )
      : await this.dataSource.query(
          'UPDATE user SET balance = balance - ? WHERE id = ? AND balance >= ?',
          [price, user.id, price],
        );
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
  private async deductViaWallet(
    account: ExternalApiAccountEntity,
    order: OrderEntity,
    settleAmount: number,
  ): Promise<void> {
    const user = account.user;

    // billingUserId = account.user.id (external 은 대행주문 없음, 1:1). wallet 없으면 fail-closed.
    let wallet;
    try {
      wallet = await this.walletAccountResolverService.resolveByUserId(
        user.id,
        this.dataSource.manager,
      );
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
      deliveryIdsForAttempt: allocation.lines
        .map((l) => l.orderDeliveryId)
        .filter((id): id is number => id != null),
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
    order.isSettleBalance =
      finalAllocation.creditUsedAmount === 0 && finalAllocation.creditExcessAmount === 0;
    order.isCreditExcess = finalAllocation.creditExcessAmount > 0;

    const isCompany = user.company?.balanceManagementType === 'COMPANY';
    if (isCompany) {
      await this.dataSource.manager.query(
        'UPDATE user_company SET balance = balance - ? WHERE id = ?',
        [finalAllocation.depositUsedAmount, user.companyId],
      );
    }
    const allSettleDelta = finalAllocation.creditUsedAmount + finalAllocation.creditExcessAmount;
    await this.dataSource.manager.query(
      'UPDATE user SET allSettleAmount = allSettleAmount + ? WHERE id = ?',
      [allSettleDelta, user.id],
    );

    // order 변경분 저장 (mirror 필드: settleAmount/isSettleBalance/isCreditExcess).
    await this.orderRepository.save(order);
  }

  private async refundBalance(account: ExternalApiAccountEntity, price: number): Promise<void> {
    const user = account.user;
    const isCompany = user.company?.balanceManagementType === 'COMPANY';
    if (isCompany) {
      await this.dataSource.query('UPDATE user_company SET balance = balance + ? WHERE id = ?', [price, user.companyId]);
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
    account: ExternalApiAccountEntity,
    order: OrderEntity,
    orderDelivery: OrderDeliveryEntity,
    eventType: OrderPaymentRefundEventType,
    idempotencyPrefix: 'fail_refund' | 'discard_refund',
  ): Promise<void> {
    const manager = this.dataSource.manager;
    const user = account.user;

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
      throw new Error(
        `wallet-managed order ${order.id} missing allocation — drift, aborting external refund`,
      );
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
  //  - 카드할증 여부: COMPANY 모드는 user_company.settleMethod, 그 외는 user.settleMethod ('CARD'면 true)
  //  - 할인/할증: user_discount 자동 매칭(findMatchingDiscount). 매칭 없으면 정가 그대로
  //  - settleAmount = applyCardSurcharge(OrderFeeCalculator(...), cardSurchargeApplied)

  private resolveCardSurchargeApplied(account: ExternalApiAccountEntity): boolean {
    const user = account.user;
    const isCompanyMode = user.company?.balanceManagementType === 'COMPANY';
    const settleMethod = isCompanyMode
      ? user.company?.settleMethod
      : user.settleMethod;
    return settleMethod === IUserSettleMethod.CARD;
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
    const where: Array<{ userId?: number; partnerCompanyId?: number }> = [
      { userId: account.user.id },
    ];
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

    const cardSurchargeApplied = this.resolveCardSurchargeApplied(account);
    const settleAmount = applyCardSurcharge(unitPrice, cardSurchargeApplied);

    return { fee, priceAdjustment, settleAmount, cardSurchargeApplied };
  }

  // ─── 할당 상품 헬퍼 ─────────────────────────────────────

  private async getAssignedProductIds(userId: number): Promise<number[]> {
    const mappings = await this.syncProductEventMappingRepository
      .createQueryBuilder('m')
      .innerJoin('m.userSyncProductEvent', 'e')
      .select('m.productId')
      .where('e.businessUserId = :userId', { userId })
      .andWhere('e.status = :status', { status: IUserSyncProductStatus.ACTIVE })
      .andWhere('m.deletedAt IS NULL')
      .getMany();
    return mappings.map((m) => m.productId);
  }

  // ─── 발송 헬퍼 ──────────────────────────────────────────

  private async dispatchSend(
    orderDelivery: OrderDeliveryEntity,
  ): Promise<DeliverySendHistoryEntity> {
    const mapping = orderDelivery.orderProductMapping;
    const product = mapping.product;

    const decryptedTarget =
      this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.deliveryTarget) ?? orderDelivery.deliveryTarget;

    const body = applyReplaceCharacters(mapping.sendContent || '', orderDelivery);
    const memoRaw = product.memo;
    const memo = memoRaw && orderDelivery.deliveryMethod !== IOrderSendMethod.EMAIL && mapping.order?.type !== IOrderType.SSG
      ? applyReplaceCharacters(memoRaw, orderDelivery)
      : null;
    const tailRaw = mapping.sendTailText;
    const tailText = tailRaw ? applyReplaceCharacters(tailRaw, orderDelivery) : null;

    const encryptKey = this.cryptoCipher.encryptJson({
      id: orderDelivery.id,
      transactionId: orderDelivery.transactionId,
    }, couponTokenExpiry(orderDelivery.expireAt));

    const deliveryHistory = new DeliverySendHistoryEntity();
    deliveryHistory.context = '{}';
    deliveryHistory.isSuccess = true;
    deliveryHistory.target = decryptedTarget;
    deliveryHistory.deliveryMethod = orderDelivery.deliveryMethod;

    const filePathList = orderDelivery.imagePath ? [orderDelivery.imagePath] : [];
    const title = mapping.sendTitle || product.name;

    if (orderDelivery.deliveryMethod === IOrderSendMethod.ALIM_TALK) {
      await this.deliverySendService.sendAlimTalk(
        orderDelivery, decryptedTarget, encryptKey, title, body, memo, tailText, filePathList, deliveryHistory,
      );
    } else if (orderDelivery.deliveryMethod === IOrderSendMethod.MMS) {
      await this.deliverySendService.sendSms(
        orderDelivery, decryptedTarget, encryptKey, title, body, memo, tailText, filePathList, deliveryHistory,
      );
    } else if (orderDelivery.deliveryMethod === IOrderSendMethod.EMAIL) {
      const emailText = tailText ? `${body}\n\n${tailText}` : body;
      await this.deliverySendService.sendEmail(
        orderDelivery, decryptedTarget, encryptKey, title, emailText, deliveryHistory,
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

  async getProducts(account: ExternalApiAccountEntity, productCode?: string): Promise<ExternalApiResponse<ProductResponseData[]>> {
    const user = account.user;
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

  async createOrder(account: ExternalApiAccountEntity, dto: CreateExternalOrderDto): Promise<ExternalApiResponse<OrderResponseData>> {
    const { order, orderDelivery, product } = await this.phaseA_createAndDeduct(account, dto);

    const externalTrId = orderDelivery.externalTrId!;

    try {
      await this.phaseB_issueAndSend(orderDelivery);
    } catch (error) {
      this.logger.error(`[createOrder] Phase B 실패 - externalTrId: ${externalTrId}`, error);
      await this.phaseC_handleFailure(order, orderDelivery, account, error);
      throw translatePartnerError(error, 'issue');
    }

    await this.phaseC_handleSuccess(order, orderDelivery);

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

  // ─── Phase A: 주문 생성 + 잔액 차감 ─────────────────────

  @Transactional()
  private async phaseA_createAndDeduct(account: ExternalApiAccountEntity, dto: CreateExternalOrderDto) {
    const user = account.user;

    // 독립 쿼리(상품 조회 / 할당 상품 ID / 직전 주문 코드)는 병렬화하여 round-trip 절약
    const [product, assignedIds, prevOrder] = await Promise.all([
      this.productRepository.findOne({
        where: { code: dto.productCode, useStatus: IProductUseStatus.USE },
        relations: ['partnerCompany', 'brand'],
      }),
      this.getAssignedProductIds(user.id),
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
    const { fee, priceAdjustment, settleAmount, cardSurchargeApplied } =
      await this.computeSettlement(account, product, sendAmount);

    // 발신번호 SoT 검증(차감 전, flag gating). 차감은 아래 order 그래프 저장 후 wallet/legacy 분기에서 수행.
    if (process.env.FROM_PHONE_SOT_ENFORCE === 'true') {
      await this.orderFromService.assertApprovedPhones(user.id, [
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
      clientUserId: null,
      ...buildOrderUserSnapshot(user),
      ...buildOrderClientUserSnapshot(null),
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
      await this.deductViaWallet(account, order, settleAmount);
    } else {
      await this.deductBalance(account, settleAmount);
    }

    return { order, orderDelivery, mapping, product };
  }

  // ─── Phase B: 쿠폰 발행 + 발송 (트랜잭션 없음) ──────────

  private async phaseB_issueAndSend(
    orderDelivery: OrderDeliveryEntity,
    ssgEvent: SsgEventEntity | null = null,
  ) {
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
      const expireDate = orderDelivery.expireAt
        ? dayjs(orderDelivery.expireAt).format('YYYY. MM. DD')
        : null;
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

    const isCompanyMode = account.user.company?.balanceManagementType === 'COMPANY';
    const isSsg = order.type === IOrderType.SSG && !!orderDelivery.ssgEventId;
    const isWalletManaged = await this.walletManagedPredicate.isWalletManaged(
      order.id,
      this.dataSource.manager,
    );

    // R7-A: claim 멱등 게이트 (내부 batch 패턴).
    //  - legacy: 중복이면 이전 처리 성공이므로 short-circuit return.
    //  - wallet: claim 만 commit 되고 wallet 환불이 실패한 retry 케이스 가능 → 흡수 후 wallet 재시도 진행.
    try {
      await this.refundLedgerService.claim({
        orderDeliveryId: orderDelivery.id,
        userId: account.user.id,
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
          this.logger.warn(
            `[EXTERNAL_FAIL] 환불 중복 차단 (정상, legacy) - orderDelivery.id: ${orderDelivery.id}`,
          );
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
        account,
        order,
        orderDelivery,
        OrderPaymentRefundEventType.FAIL_REFUND,
        'fail_refund',
      );
    } else {
      await this.refundBalance(account, order.settleAmount);
    }
  }

  // ─── 주문 상태 조회 ─────────────────────────────────────

  async getOrderStatus(account: ExternalApiAccountEntity, trId: string): Promise<ExternalApiResponse<OrderStatusResponseData>> {
    const orderDelivery = await this.findOrderDeliveryByTrId(account, trId);
    const mapping = orderDelivery.orderProductMapping;
    const product = mapping?.product;
    const order = mapping?.order;
    const price = product?.price ?? 0;
    const settleAmount = order?.settleAmount ?? 0;
    const { validStartDate, validEndDate } = this.resolveValidDates(orderDelivery);

    return ExternalApiResponse.success<OrderStatusResponseData>({
      trId: orderDelivery.externalTrId!,
      couponStatus: this.toExternalCouponStatus(orderDelivery.couponStatus),
      barCode: orderDelivery.barCode || undefined,
      validStartDate,
      validEndDate,
      price,
      settleAmount,
    });
  }

  // ─── SSG 주문 상태 조회 ─────────────────────────────────

  async getSsgOrderStatus(account: ExternalApiAccountEntity, trId: string): Promise<ExternalApiResponse<SsgOrderStatusResponseData>> {
    const orderDelivery = await this.findOrderDeliveryByTrId(account, trId);
    const order = orderDelivery.orderProductMapping?.order;
    const price = order?.sendAmount ?? 0;
    const settleAmount = order?.settleAmount ?? 0;
    const { validStartDate, validEndDate } = this.resolveValidDates(orderDelivery);

    return ExternalApiResponse.success<SsgOrderStatusResponseData>({
      trId: orderDelivery.externalTrId!,
      couponStatus: this.toExternalCouponStatus(orderDelivery.couponStatus),
      barCode: orderDelivery.barCode || undefined,
      personalCode: orderDelivery.personalCode || undefined,
      validStartDate,
      validEndDate,
      price,
      settleAmount,
    });
  }

  // ─── 주문 취소 ──────────────────────────────────────────

  async cancelOrder(account: ExternalApiAccountEntity, trId: string): Promise<ExternalApiResponse> {
    const orderDelivery = await this.findOrderDeliveryByTrId(account, trId);
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

    const isCompanyMode = account.user.company?.balanceManagementType === 'COMPANY';
    const isWalletManaged = await this.walletManagedPredicate.isWalletManaged(
      order.id,
      this.dataSource.manager,
    );
    await this.refundLedgerService.claim({
      orderDeliveryId: orderDelivery.id,
      userId: account.user.id,
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
        account,
        order,
        orderDelivery,
        OrderPaymentRefundEventType.DISCARD_REFUND,
        'discard_refund',
      );
    } else {
      await this.refundBalance(account, order.settleAmount);
    }
  }

  // ─── 재발송 ─────────────────────────────────────────────

  async resendOrder(account: ExternalApiAccountEntity, trId: string): Promise<ExternalApiResponse> {
    const orderDelivery = await this.findOrderDeliveryByTrId(account, trId);
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
    if (orderDelivery.resendCount >= max) {
      throw new ExternalApiException(
        '3008',
        `재발송 횟수 초과 (${orderDelivery.resendCount}/${max})`,
      );
    }

    const history = await this.dispatchSend(orderDelivery);
    if (!history.isSuccess) {
      throw new ExternalApiException('3003', '재발송 실패');
    }

    orderDelivery.resendAt = new Date();
    orderDelivery.resendCount += 1;
    await this.orderDeliveryRepository.save(orderDelivery);

    return ExternalApiResponse.success();
  }

  // ─── SSG 주문 생성 ──────────────────────────────────────

  async createSsgOrder(account: ExternalApiAccountEntity, dto: CreateExternalSsgOrderDto): Promise<ExternalApiResponse<SsgOrderResponseData>> {
    if (!account.ssgEnabled) {
      throw new ExternalApiException('1005', 'SSG 미승인 계정');
    }

    const { order, orderDelivery, ssgEvent } = await this.phaseA_createSsgAndDeduct(account, dto);

    const externalTrId = orderDelivery.externalTrId!;

    try {
      await this.phaseB_issueAndSend(orderDelivery, ssgEvent);
    } catch (error) {
      this.logger.error(`[createSsgOrder] Phase B 실패 - externalTrId: ${externalTrId}`, error);
      await this.phaseC_handleFailure(order, orderDelivery, account, error);
      throw translatePartnerError(error, 'issue');
    }

    await this.phaseC_handleSuccess(order, orderDelivery);

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

  @Transactional()
  private async phaseA_createSsgAndDeduct(account: ExternalApiAccountEntity, dto: CreateExternalSsgOrderDto) {
    const user = account.user;
    const sendAmount = dto.amount;

    // 요청 금액과 일치하는 SSG 상품을 확정(없으면 템플릿으로 생성).
    // 내부 admin /order/ssg 흐름과 동일한 resolver를 사용해 sendAmount === product.price 보장.
    const product = await this.productService
      .findOrCreateSsgProductByPrice(sendAmount)
      .catch(() => {
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

    const { fee, priceAdjustment, settleAmount, cardSurchargeApplied } =
      await this.computeSettlement(account, product, sendAmount);

    // senderPhone 미지정 SSG 알림톡 → 자사 대표번호로 확정 (검증/저장 동일값)
    const effectiveSenderPhone = dto.senderPhone ?? systemFromPhoneNumber;

    // 발신번호 SoT 검증(차감 전, flag gating). 차감은 아래 order 그래프 저장 후 wallet/legacy 분기에서 수행.
    if (process.env.FROM_PHONE_SOT_ENFORCE === 'true') {
      await this.orderFromService.assertApprovedPhones(user.id, [
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
      clientUserId: null,
      ...buildOrderUserSnapshot(user),
      ...buildOrderClientUserSnapshot(null),
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
      await this.deductViaWallet(account, order, settleAmount);
    } else {
      await this.deductBalance(account, settleAmount);
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
    return status === OrderDeliveryCouponStatus.CANCEL
      ? ExternalCouponStatus.DISCARDED
      : ExternalCouponStatus.ISSUED;
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

  private async findOrderDeliveryByTrId(account: ExternalApiAccountEntity, trId: string): Promise<OrderDeliveryEntity> {
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
    if (!order || order.userId !== account.user.id) {
      throw new ExternalApiException('4002', '주문에 대한 접근 권한 없음');
    }

    return orderDelivery;
  }

  /**
   * transactionId + externalTrId(ULID) 한 번에 저장. ULID unique 제약 위반 시 재생성 후 retry.
   */
  private async saveTransactionIds(
    orderDeliveryId: number,
    transactionId: string,
  ): Promise<string> {
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
