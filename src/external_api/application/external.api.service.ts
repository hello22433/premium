import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Not, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import dayjs from 'dayjs';

import { OrderEntity } from '../../entity/order.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { DeliveryWorkflowEntity } from '../../entity/delivery.workflow.entity';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { ProductEntity } from '../../entity/product.entity';
import { UserEntity } from '../../entity/user.entity';
import { DeliverySendHistoryEntity } from '../../entity/delivery.send.history.entity';
import { UserSyncProductEventMappingEntity } from '../../entity/user.sync.product.event.mapping.entity';
import { ExternalApiAccountEntity } from '../../entity/external.api.account.entity';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { DeliveryCancelIntentEntity } from '../../entity/delivery.cancel.intent.entity';
import {
  OrderPaymentRefundEventEntity,
  OrderPaymentRefundEventType,
} from '../../entity/order.payment.refund.event.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { UserDiscountEntity } from '../../entity/user.discount.entity';
import { IUserSyncProductStatus } from '../../user_sync_product/interface/user.sync.product.status';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserSettleMethod } from '../../user/interface/user.settle.method';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { findMatchingDiscount } from '../../user_discount/domain/discount.matcher';
import { OrderFeeCalculator, applyCardSurcharge } from '../../order/domain/order.fee.calculator';
import {
  buildLineProductSnapshot,
  buildPartnerSettleSnapshot,
  buildOrderClientUserSnapshot,
  buildOrderOperationUserSnapshot,
  buildOrderUserSnapshot,
} from '../../order/util/order.snapshot.builder';

import { IOrderType } from '../../order/interface/order.type';
import { IOrderStatus } from '../../order/interface/order.status';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { MUTATION_CLAIM_STALE_MS } from '../../delivery/interface/order.delivery.mutation.claim';
import { IOrderSendMethod } from '../../order/interface/order.send.method';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { IProductUseStatus } from '../../product/interface/product.status';
import { IProductType } from '../../product/interface/product.type';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';

import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { DeliverySendService } from '../../delivery/application/delivery.send.service';
import { RefundLedgerService } from '../../delivery/application/refund-ledger.service';
import { DeliveryCutoverGuardService } from '../../delivery/application/delivery-cutover-guard.service';
import {
  LegacyDeliveryEntryPoint,
  NOT_CUTOVER_ORDER_DELIVERY,
} from '../../delivery/interface/legacy.delivery.entry.point';
import { SsgRecoveryService } from '../../delivery/application/ssg-recovery.service';
import { SsgRecoveryResult } from '../../delivery/interface/ssg.recovery.result';
import {
  ExecuteRefundContext,
  RefundAttemptExecutorService,
} from '../../delivery/application/refund-attempt-executor.service';
import { RefundAttemptStatus, RefundScope } from '../../delivery/interface/refund.attempt.status';
import { MessageResultReconcileService } from '../../delivery/application/message-result-reconcile.service';
import { DeliverySlot, DeliveryWorkflowSlotService } from '../../delivery/application/delivery-workflow-slot.service';
import { DeliveryExclusiveOp, DeliveryWorkflowStatus } from '../../delivery/interface/delivery.workflow.status';
import { DeliveryCancelIntentService } from '../../delivery/application/delivery-cancel-intent.service';
import {
  DeliveryCancelIntentSource,
  DeliveryCancelIntentStatus,
} from '../../delivery/interface/delivery.cancel.intent.status';
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
  OrderLookupResponseData,
} from '../api/dto/external.api.response.dto';
import { CreateExternalOrderDto, CreateExternalSsgOrderDto } from '../api/dto/external.api.request.dto';
import { ApiRequestContext } from '../api/api-request-context';
import { getBillingUserId } from '../../order/domain/order.billing-user.helper';
import { ApiCustomerMappingResolver } from './api.customer.mapping.resolver';

import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { DeliveryCreateCouponImage } from '../../delivery/infra/delivery.create.coupon.image';
import { createTempOrderCode, deriveOrderCodeFromId } from '../../order/domain/order.code';
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
import { LegacyWalletCreditSyncService } from '../../wallet/application/legacy-wallet-credit-sync.service';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { OrderDeliveryAttemptEntity, OrderDeliveryAttemptType } from '../../entity/order.delivery.attempt.entity';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ActivityLogActionType } from '../../activity_log/interface/activity.log.action.type';
import { ActivityLogResult } from '../../activity_log/interface/activity.log.result';

type ExternalRefundBalanceChange = {
  beforeBalance: number;
  afterBalance: number;
  balanceManagementType: string;
};

/**
 * trId 기반 조회가 로딩하는 관계. 재발송(`resendOrder`)이 `AlimTalkTemplate` 을 태우므로
 * 템플릿이 참조하는 관계를 모두 포함해야 한다 — 하나라도 빠지면 템플릿에서 예외가 나고
 * 알림톡을 시도조차 못한 채 MMS 폴백으로 흘러간다(발행자명 `order.user.company`,
 * 초이스쿠폰 `choiceSelectProduct.brand`).
 */
export const EXTERNAL_ORDER_DELIVERY_RELATIONS = [
  'orderProductMapping',
  'orderProductMapping.order',
  'orderProductMapping.order.user',
  'orderProductMapping.order.user.company',
  'orderProductMapping.order.clientUser',
  'orderProductMapping.order.clientUser.company',
  'orderProductMapping.product',
  'orderProductMapping.product.partnerCompany',
  'orderProductMapping.product.brand',
  'choiceSelectProduct',
  'choiceSelectProduct.brand',
];

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
    private legacyWalletCreditSyncService: LegacyWalletCreditSyncService,
    private activityLogService: ActivityLogService,
    private cutoverGuard: DeliveryCutoverGuardService,
    private refundAttemptExecutor: RefundAttemptExecutorService,
    private messageResultReconcileService: MessageResultReconcileService,
    private deliveryWorkflowSlotService: DeliveryWorkflowSlotService,
    private deliveryCancelIntentService: DeliveryCancelIntentService,
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
    await this.dataSource.manager.query('UPDATE user SET all_settle_amount = all_settle_amount + ? WHERE id = ?', [
      allSettleDelta,
      user.id,
    ]);

    // order 변경분 저장 (mirror 필드: settleAmount/isSettleBalance/isCreditExcess).
    await this.orderRepository.save(order);
  }

  private async refundBalance(billingUser: UserEntity, price: number): Promise<ExternalRefundBalanceChange> {
    const user = billingUser;
    const isCompany = user.company?.balanceManagementType === 'COMPANY';
    if (isCompany) {
      const result = await this.dataSource.manager.query('UPDATE user_company SET balance = balance + ? WHERE id = ?', [
        price,
        user.companyId,
      ]);
      if (result?.affectedRows !== 1) {
        throw new ExternalApiException('9999', '시스템 오류', '외부 API 회사 예치금 환불 대상 없음');
      }
      const rows = await this.dataSource.manager.query('SELECT balance FROM user_company WHERE id = ?', [
        user.companyId,
      ]);
      if (!rows?.[0]) {
        throw new ExternalApiException('9999', '시스템 오류', '외부 API 회사 예치금 환불 잔액 조회 실패');
      }
      const afterBalance = Number(rows?.[0]?.balance ?? 0);
      return {
        beforeBalance: afterBalance - price,
        afterBalance,
        balanceManagementType: user.company?.balanceManagementType ?? 'COMPANY',
      };
    } else {
      const result = await this.dataSource.manager.query('UPDATE user SET balance = balance + ? WHERE id = ?', [
        price,
        user.id,
      ]);
      if (result?.affectedRows !== 1) {
        throw new ExternalApiException('9999', '시스템 오류', '외부 API 사용자 예치금 환불 대상 없음');
      }
      const rows = await this.dataSource.manager.query('SELECT balance FROM user WHERE id = ?', [user.id]);
      if (!rows?.[0]) {
        throw new ExternalApiException('9999', '시스템 오류', '외부 API 사용자 예치금 환불 잔액 조회 실패');
      }
      const afterBalance = Number(rows?.[0]?.balance ?? 0);
      return {
        beforeBalance: afterBalance - price,
        afterBalance,
        balanceManagementType: user.company?.balanceManagementType ?? 'ACCOUNT',
      };
    }
  }

  private async logExternalRefundActivity(input: {
    billingUser: UserEntity;
    order: OrderEntity;
    orderDelivery: OrderDeliveryEntity;
    amount: number;
    sourcePath: 'EXTERNAL_FAIL' | 'EXTERNAL_CANCEL';
    memo: string;
    refundLedgerId: number | null;
    balanceChange: ExternalRefundBalanceChange;
  }): Promise<void> {
    const { billingUser, order, orderDelivery, amount, sourcePath, memo, refundLedgerId, balanceChange } = input;
    const company = billingUser.company;

    await this.activityLogService.createLog(
      {
        userId: 0,
        userEmail: 'system@epopkon.com',
        method: 'SYSTEM',
        requestUrl: '/system/balance/refund',
        actionType: ActivityLogActionType.BALANCE_REFUND,
        ipAddress: '',
        statusCode: 200,
        result: ActivityLogResult.SUCCESS,
        responseTime: 0,
        requestParams: {
          targetUserId: billingUser.id,
          targetUserEmail: billingUser.email,
          targetBusinessName: company?.businessName ?? '',
          targetCompanyId: company?.id ?? null,
          balanceManagementType: balanceChange.balanceManagementType,
          chargeAmount: amount,
          beforeBalance: balanceChange.beforeBalance,
          afterBalance: balanceChange.afterBalance,
          memo,
          sourcePath,
          orderId: order.id,
          orderDeliveryId: orderDelivery.id,
          externalTrId: orderDelivery.externalTrId ?? null,
          refundLedgerId,
        },
      },
      this.dataSource.manager,
    );
  }

  @Transactional()
  private async refundLegacyBalanceAndAudit(input: {
    billingUser: UserEntity;
    order: OrderEntity;
    orderDelivery: OrderDeliveryEntity;
    sourcePath: 'EXTERNAL_FAIL' | 'EXTERNAL_CANCEL';
    transactionType: 'FAIL_REFUND' | 'DISCARD_REFUND';
    idempotencyKey: string;
    memo: string;
    refundLedgerId: number | null;
  }): Promise<void> {
    const { billingUser, order, orderDelivery, sourcePath, transactionType, idempotencyKey, memo, refundLedgerId } =
      input;
    const balanceChange = await this.refundBalance(billingUser, order.settleAmount);
    await this.legacyWalletCreditSyncService.syncDeposit(this.dataSource.manager, {
      billingUserId: billingUser.id,
      orderId: order.id,
      orderDeliveryId: orderDelivery.id,
      delta: order.settleAmount,
      type: transactionType,
      idempotencyKey,
      memo,
    });
    await this.logExternalRefundActivity({
      billingUser,
      order,
      orderDelivery,
      amount: order.settleAmount,
      sourcePath,
      memo,
      refundLedgerId,
      balanceChange,
    });
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
    await this.dataSource.transaction('READ COMMITTED', async (manager) => {
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
          idempotencyKeyPrefix: `${this.walletRefundKeyPrefix(idempotencyPrefix, order, orderDelivery)}${latestAttempt.id}`,
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
      await manager.query('UPDATE user SET all_settle_amount = all_settle_amount - ? WHERE id = ?', [
        allSettleDelta,
        user.id,
      ]);
    });
  }

  // ─── 정산 헬퍼 ──────────────────────────────────────────
  // 일반 주문(order.service.ts)과 동일한 정산 모델을 외부 API에도 적용.
  //  - 카드할증 여부: billingUser 정산코드 wallet.settleMethod === 'CARD' (SoT, cutover mode 반영). LEGACY 는 company 폴백
  //  - 할인/할증: user_discount 자동 매칭(findMatchingDiscount). 매칭 없으면 정가 그대로
  //  - settleAmount = applyCardSurcharge(OrderFeeCalculator(...), cardSurchargeApplied)

  private resolveCardSurchargeApplied(account: ExternalApiAccountEntity): Promise<boolean> {
    return this.resolveCardSurchargeAppliedForUser(account.user);
  }

  // billingUser 기준 카드할증 판정. SoT = 정산코드 wallet.settleMethod === 'CARD' && wallet.cardSurchargeApplied (order.service §4.0 와 동일 모델).
  //  - WALLET: wallet.settleMethod + 토글 (미존재 시 fail-closed throw — 잘못된 결제수단 영구저장 방지)
  //  - SHADOW: wallet 성공 시 토글 반영 / 실패 시 company 폴백(토글 미개입)
  //  - LEGACY: company.settleMethod (user.settleMethod 는 deprecated, 토글 미개입)
  private async resolveCardSurchargeAppliedForUser(user: UserEntity): Promise<boolean> {
    const mode = this.walletCutoverConfig.pr3SettleMode;
    const companyApplied = user.company?.settleMethod === IUserSettleMethod.CARD;
    if (mode === WalletCutoverMode.LEGACY) {
      return companyApplied;
    }
    try {
      const wallet = await this.walletAccountResolverService.resolveByUserId(user.id);
      return wallet.settleMethod === 'CARD' && !!wallet.cardSurchargeApplied;
    } catch (e) {
      if (mode === WalletCutoverMode.WALLET) {
        throw e; // fail-closed
      }
      this.logger.warn(`[card surcharge] SHADOW wallet 조회 실패 → legacy(회사) 폴백: ${(e as Error).message}`);
      return companyApplied;
    }
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
      cardSurchargeApplied: await this.resolveCardSurchargeApplied(account),
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
    const userDiscounts = (
      await this.userDiscountRepository.find({
        where: { userId: billingUser.id },
      })
    ).filter((discount) => discount.userId === billingUser.id);

    const cardSurchargeApplied =
      appOptions?.cardSurchargeApplied ?? (await this.resolveCardSurchargeAppliedForUser(billingUser));
    const { fee, priceAdjustment, settleAmount } = this.computeUnitSettlement(
      product,
      userDiscounts,
      sendAmount,
      cardSurchargeApplied,
    );

    return { fee, priceAdjustment, settleAmount, cardSurchargeApplied };
  }

  // 순수 단가 정산(DB 접근 없음). 할인목록을 주입받아 할인(findMatchingDiscount)+카드할증을 적용한 단가를 산출.
  // computeSettlementForBilling(주문 정산)과 getProductsForBilling(카탈로그 salePrice)이 공유 — 단일 소스.
  // SSG처럼 sendAmount가 product.price와 다른 경우에도 정확히 매칭하도록 sendAmount를 priceOverride로 전달.
  private computeUnitSettlement(
    product: ProductEntity,
    userDiscounts: UserDiscountEntity[],
    sendAmount: number,
    cardSurchargeApplied: boolean,
  ): { fee: number | null; priceAdjustment: IPriceAdjustment | null; settleAmount: number } {
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

    const settleAmount = applyCardSurcharge(unitPrice, cardSurchargeApplied);

    return { fee, priceAdjustment, settleAmount };
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
    // orderDeliveryId 를 채워 발송 성공 이력을 order_delivery 에 연결한다(async 발송 경로와 동일).
    // Phase B(발송) 성공 후 Phase C(완료 전이) 전에 크래시하면 order 가 DELIVERY_REQUEST 로 stuck 되는데,
    // 이 링크가 있어야 복구 스윕이 "발송 성공(isSuccess=true) 이력 존재"를 근거로 안전하게 완료 전이할 수 있다.
    deliveryHistory.orderDeliveryId = orderDelivery.id;
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
      ctx.apiApp.requireExternalCustomerId,
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

    // salePrice = 고객사 기준 실제 청구 단가(할인 + 카드할증).
    // 협력사 정산 수수료(partnerCompanyId 기준 user_discount)는 자사↔협력사 간 정산이며
    // 고객사 청구단가 산출 대상이 아니므로 userId 조건만 로딩한다.
    const cardSurchargeApplied = await this.resolveCardSurchargeAppliedForUser(user);
    const allDiscounts = await this.userDiscountRepository.find({ where: { userId: user.id } });

    const data: ProductResponseData[] = products.map((p) => {
      const { settleAmount } = this.computeUnitSettlement(p, allDiscounts, p.price, cardSurchargeApplied);
      return {
        productCode: p.code,
        productName: p.name,
        brandName: p.brand?.nameKorean ?? '',
        price: p.price,
        salePrice: settleAmount,
        imageUrl: p.imagePath,
        validDays: p.expireDay,
        type: p.type,
        memo: p.memo,
        isCancelable: p.isCancelable,
      };
    });

    return ExternalApiResponse.success(data);
  }

  // ─── 주문 생성 (3-phase) ────────────────────────────────

  async createOrder(
    account: ExternalApiAccountEntity,
    dto: CreateExternalOrderDto,
    ctx: ApiRequestContext,
  ): Promise<ExternalApiResponse<OrderResponseData>> {
    // externalOrderId 필수 모드: 크래시/타임아웃 재시도 이중발급 방어선(UNIQUE order_axis)을 강제.
    this.assertExternalOrderIdIfRequired(ctx, dto.externalOrderId);
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
      ctx.apiApp.requireExternalCustomerId,
    );

    // 독립 쿼리(상품 조회 / 할당 상품 ID)는 병렬화하여 round-trip 절약
    const [product, assignedIds] = await Promise.all([
      this.productRepository.findOne({
        where: { code: dto.productCode, useStatus: IProductUseStatus.USE },
        relations: ['partnerCompany', 'partnerCompany.userDiscounts', 'brand'],
      }),
      this.getAssignedProductIdsForBilling(billingUser.id),
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
      { cardSurchargeApplied: await this.resolveCardSurchargeAppliedForUser(billingUser) },
    );

    // 발신번호 SoT 검증(차감 전, flag gating). 차감은 아래 order 그래프 저장 후 wallet/legacy 분기에서 수행.
    if (process.env.FROM_PHONE_SOT_ENFORCE === 'true') {
      await this.orderFromService.assertApprovedPhones(billingUser.id, [
        { sendMethod: dto.deliveryMethod as IOrderSendMethod, fromPhoneNumber: dto.senderPhone ?? null },
      ]);
    }

    const order = this.orderRepository.create({
      userId: user.id,
      code: createTempOrderCode(),
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

    // 2-step 채번: id 확정 후 EPEVT 코드로 확정(같은 트랜잭션 → 임시코드 커밋 전 소멸)
    order.code = deriveOrderCodeFromId(order.id);
    await this.orderRepository.save(order);

    const lineSnapshot = buildLineProductSnapshot(product);
    const mapping = this.orderProductMappingRepository.create({
      orderId: order.id,
      productId: product.id,
      // ⚠️ D3-53 전제: 외부 일반주문은 단일라인. amount 가 1 이 아니게 되면 위 sendAmount(=product.price)가
      //    '단가'가 아니라 '총액'이 되어, getOrderStatus 가 응답 price 로 노출하는 값의 의미가 조용히 바뀐다.
      //    → 수량 도입 시 getOrderStatus/getSsgOrderStatus 의 price 소스를 반드시 재검토할 것.
      amount: 1,
      sendContent: dto.message || '',
      sendTitle: dto.title || product.name,
      fromPhoneNumber: dto.senderPhone,
      sendMethod: dto.deliveryMethod as IOrderSendMethod,
      fee,
      priceAdjustment,
      topImagePath: '',
      midImagePath: '',
      ...lineSnapshot,
      ...buildPartnerSettleSnapshot(product, lineSnapshot.snapshotProductPrice ?? product.price),
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

  /**
   * phaseC 의 발송 결과 영속 — save(orderDelivery) 금지, targeted update (D3-60 clobber).
   *
   * save 는 merge 라 **행 전체**를 phaseA 시점 스냅샷으로 쓴다. phaseB(협력사 발급 + 문자 발송)는
   * 외부 통신이라 수 초가 걸리고, 그 사이 CS 폐기가 들어오면 save 가 남이 쓴 값을 되돌린다:
   *   - coupon_status='CANCEL' → 'NOT_USED'  (환불은 끝났는데 되살아난 쿠폰)
   *   - deleted_at             → NULL         (지워진 행 부활)
   *   - mutation_claimed_at    → NULL         (CS 폐기가 쥔 lease 무력화 = 1차 방어 파괴)
   *
   * ┌─ 【의도적 설계 결정 — 잊은 것이 아님】 2026-07-24 ────────────────────────────┐
   * │ fencing(`AND mutation_claimed_at = 내토큰`)은 **불가능하고, 또 불필요하다.**   │
   * │                                                                              │
   * │ 불가능: 주문 생성 경로(createOrder/createSsgOrder)는 변형 lease 를 아예 안     │
   * │   잡는다 — acquireMutationLease 는 파일 전체에서 cancelOrder 한 곳뿐. 쥔       │
   * │   토큰이 없으니 WHERE 에 실을 것이 없다.                                       │
   * │ 불필요: phaseC 는 **갓 만든 행**을 쓴다. 이 창(phaseB, 수 초)에 겹칠 변형       │
   * │   액터가 사실상 없다 —                                                         │
   * │   · 협력사 취소(cancelOrder)는 externalTrId 가 있어야 하는데, 그건 createOrder │
   * │     가 응답을 반환해야 협력사에 전달된다. phaseB 도는 중엔 응답 전이라 불가.    │
   * │   · 배치 발송은 external 주문을 claim 대상에서 아예 배제한다(order.type 필터).  │
   * │   · CS 폐기는 이론상만 — 방금 생성된 쿠폰을 수 초 안에 찾아 폐기해야 도달.      │
   * │   (대조: resendOrder 는 이미 존재하는 쿠폰이라 겹칠 창이 실재 → 거기엔 lease+  │
   * │    fencing 을 넣었다. 생성 경로는 그 상황이 아니다.)                           │
   * │ 그래서 여기 save→targeted update 는 "살아있는 구멍" 봉합이 아니라 D3-60 위생    │
   * │ (stale 전체엔티티 의존 제거 + 나머지 경로와 일관성)이다.                       │
   * └──────────────────────────────────────────────────────────────────────────────┘
   *
   * 아래가 **phaseC 말고는 아무도 안 쓰는 컬럼의 전부**다(전수 확인, 회귀는
   * external.api.wallet-refund.spec.ts 의 "phaseC 영속 컬럼 집합 잠금" 이 잠근다):
   *   - status/actualSendAt/failedAt/apiErrorMessage : 발송 결과
   *   - expireAt   : phaseB 에서 issue() **뒤**에 계산 → persistIssuedPin 이 모르는 값
   *   - imagePath  : 자체 update 없음. 빠지면 쿠폰 이미지 영구 유실
   *   - report 4종 : 알림톡 POST 성공 표식. 빠지면 sweep 재선택 → 중복 발송
   *
   * 나머지(barCode/personalCode/couponNum/ssgTransactionId/encourageAt/ssgEventId)는
   * persistIssuedPin 이, transactionId/externalTrId 는 saveTransactionIds 가 이미 영속한다.
   */
  private async persistPhaseCResult(orderDelivery: OrderDeliveryEntity): Promise<void> {
    await this.orderDeliveryRepository.update(
      { id: orderDelivery.id },
      {
        status: orderDelivery.status,
        actualSendAt: orderDelivery.actualSendAt,
        failedAt: orderDelivery.failedAt,
        apiErrorMessage: orderDelivery.apiErrorMessage,
        expireAt: orderDelivery.expireAt,
        imagePath: orderDelivery.imagePath,
        alimTalkMsgKey: orderDelivery.alimTalkMsgKey,
        reportState: orderDelivery.reportState,
        reportNextDueAt: orderDelivery.reportNextDueAt,
        reportDeadlineAt: orderDelivery.reportDeadlineAt,
      },
    );
  }

  // ─── Phase C: 성공 상태 업데이트 ─────────────────────────

  @Transactional()
  private async phaseC_handleSuccess(order: OrderEntity, orderDelivery: OrderDeliveryEntity) {
    if (!orderDelivery.actualSendAt) {
      orderDelivery.actualSendAt = new Date();
    }
    await this.persistPhaseCResult(orderDelivery);

    order.status = IOrderStatus.DELIVERY_COMPLETE;
    await this.orderRepository.save(order);
  }

  // ─── Phase C: 실패 처리 + 환불 ──────────────────────────

  private async phaseC_handleFailure(
    order: OrderEntity,
    orderDelivery: OrderDeliveryEntity,
    account: ExternalApiAccountEntity,
    error: any,
  ) {
    const isCutover = await this.cutoverGuard.isCutover(orderDelivery.id);
    if (!isCutover) {
      await this.phaseC_handleLegacyFailure(order, orderDelivery, account, error);
      return;
    }

    await this.phaseC_persistFailure(order, orderDelivery, error);
    await this.messageResultReconcileService.markWorkflowFailedIfSettled(orderDelivery.id, new Date());
    await this.refundAttemptExecutor.execute({
      orderDeliveryId: orderDelivery.id,
      amount: order.settleAmount,
      scope: RefundScope.FULL,
      externalIdempotencyKey: `external-fail:${orderDelivery.id}:${ulid()}`,
      execute: async (fencing) => {
        await this.phaseC_executeFailureRefund(order, orderDelivery, account, fencing);
        return { status: RefundAttemptStatus.SUCCEEDED };
      },
    });
  }

  @Transactional()
  private async phaseC_handleLegacyFailure(
    order: OrderEntity,
    orderDelivery: OrderDeliveryEntity,
    account: ExternalApiAccountEntity,
    error: any,
  ): Promise<void> {
    await this.cutoverGuard.assertLegacyAllowed(orderDelivery.id, LegacyDeliveryEntryPoint.EXTERNAL_API_FAIL_REFUND);
    await this.phaseC_persistFailure(order, orderDelivery, error);
    await this.phaseC_executeFailureRefund(order, orderDelivery, account);
  }

  @Transactional()
  private async phaseC_persistFailure(
    order: OrderEntity,
    orderDelivery: OrderDeliveryEntity,
    error: any,
  ): Promise<void> {
    orderDelivery.status = IOrderDeliveryStatus.FAIL;
    orderDelivery.apiErrorMessage = error?.message?.substring(0, 500) ?? null;
    if (!orderDelivery.failedAt) {
      orderDelivery.failedAt = new Date();
    }
    await this.persistPhaseCResult(orderDelivery);

    order.status = IOrderStatus.DELIVERY_CANCEL;
    await this.orderRepository.save(order);
  }

  private async phaseC_executeFailureRefund(
    order: OrderEntity,
    orderDelivery: OrderDeliveryEntity,
    account: ExternalApiAccountEntity,
    refundExecution?: ExecuteRefundContext,
  ): Promise<void> {
    const billingUser = await this.loadOrderBillingUser(order, account.user);
    const isCompanyMode = billingUser.company?.balanceManagementType === 'COMPANY';
    const isSsg = order.type === IOrderType.SSG && !!orderDelivery.ssgEventId;
    const isWalletManaged = await this.walletManagedPredicate.isWalletManaged(order.id, this.dataSource.manager);

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
        ssgPending: isSsg,
        refundExecution,
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

    if (isSsg) {
      const result = refundExecution
        ? await this.ssgRecoveryService.recoverWithLease(
            orderDelivery.id,
            orderDelivery.ssgEventId!,
            order.id,
            order.sendAmount,
            undefined,
            refundExecution,
          )
        : await this.ssgRecoveryService.recoverWithLease(
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

    const refundLedgerId = await this.refundLedgerService.getLedgerId(orderDelivery.id);
    if (isWalletManaged) {
      await this.refundViaWallet(
        billingUser,
        order,
        orderDelivery,
        OrderPaymentRefundEventType.FAIL_REFUND,
        'fail_refund',
      );
      return;
    }

    await this.refundLegacyBalanceAndAudit({
      billingUser,
      order,
      orderDelivery,
      sourcePath: 'EXTERNAL_FAIL',
      transactionType: 'FAIL_REFUND',
      idempotencyKey: `legacy_fail_refund:${order.id}:${orderDelivery.id}:deposit`,
      memo: `외부 API 발송 실패 환불 (주문번호: ${order.id})`,
      refundLedgerId,
    });
  }

  // ─── 주문 상태 조회 ─────────────────────────────────────

  async getOrderStatus(
    account: ExternalApiAccountEntity,
    trId: string,
    ctx: ApiRequestContext,
  ): Promise<ExternalApiResponse<OrderStatusResponseData>> {
    const orderDelivery = await this.findOrderDeliveryByTrId(account, trId, ctx);
    const mapping = orderDelivery.orderProductMapping;
    const order = mapping?.order;
    // D3-53: 응답 price 를 주문시점 박제값(order.sendAmount)으로 통일.
    //  - 생성응답(createOrder)·getSsgOrderStatus 와 3자 비트동일.
    //  - 과거엔 live product.price(가변)를 읽어, 주문 후 상품가가 바뀌면
    //    파트너 대사 시 생성응답 price 와 조회 price 가 달라졌다(표시 불일치).
    //  - 전제: 외부주문은 단일라인(생성부 amount:1)이라 sendAmount == 단가. 수량 도입 시 재검토(생성부 주석 참조).
    const price = order?.sendAmount ?? 0;
    const settleAmount = order?.settleAmount ?? 0;
    const { validStartDate, validEndDate } = this.resolveValidDates(orderDelivery);

    return ExternalApiResponse.success<OrderStatusResponseData>({
      // D3-55: 재발행 tip 은 externalTrId=null 이므로, 파트너가 보낸 요청 trId 를 그대로 echo.
      trId,
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
      // D3-55: 재발행 tip 은 externalTrId=null 이므로, 파트너가 보낸 요청 trId 를 그대로 echo.
      trId,
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

  // ─── externalOrderId(호출자 reqTrId) 기준 주문 조회 (reconcile 전용, 읽기 전용) ─────

  async getOrderStatusByExternalOrderId(
    account: ExternalApiAccountEntity,
    ctx: ApiRequestContext,
    externalOrderId: string,
  ): Promise<ExternalApiResponse<OrderLookupResponseData>> {
    const normalized = externalOrderId?.trim();
    if (!normalized) {
      throw new ExternalApiException('2001', '잘못된 요청', 'externalOrderId 필수');
    }

    // 조회가 (apiApp, externalOrderId) 로 스코프되므로 소유권이 내재적으로 보장된다.
    const order = await this.mappingResolver.findExistingOrderByExternalOrderId(ctx.apiApp.id, normalized);
    if (!order) {
      // 주문 자체가 없음 = Nest 미착지/미커밋 → 쿠폰 미발급(발급은 phaseA 커밋 이후 phaseB). 호출자는 grace 후 FAILED.
      return ExternalApiResponse.success<OrderLookupResponseData>({ found: false });
    }

    const orderDelivery = await this.orderDeliveryRepository.findOne({
      where: { orderProductMapping: { order: { id: order.id } } },
      relations: [
        'orderProductMapping',
        'orderProductMapping.order',
        'orderProductMapping.product',
        'orderProductMapping.product.partnerCompany',
      ],
      order: { id: 'DESC' },
    });
    if (!orderDelivery) {
      // phaseA 는 order+delivery 를 원자 커밋하므로 정상 도달 불가. 보수적으로 orderStatus 만 반환(처리중 취급).
      return ExternalApiResponse.success<OrderLookupResponseData>({ found: true, orderStatus: order.status });
    }

    // D3-55: reconcile 는 상태를 최신 delivery(id DESC=tip) 기준으로 보되, trId 는 externalTrId 를 가진
    // 원본(root)에서 가져온다. 재발행 tip 은 externalTrId=null 이라 그대로 쓰면 파트너가 trId 를 복구할 수 없다.
    // tip 이 이미 trId 를 가진 경우(재발행 없음)엔 추가 조회 없이 그대로 사용.
    // 정렬 없음/단건 조회지만 모호성 없음: 외부주문은 createOrder 가 매핑 1개·발송건 1개(amount:1)로 만들고
    // trId 는 root 하나에만 심긴다(재발행 tip=null). 즉 order 당 externalTrId 보유 행은 항상 root 단 하나.
    const responseTrId =
      orderDelivery.externalTrId ??
      (
        await this.orderDeliveryRepository.findOne({
          where: { orderProductMapping: { order: { id: order.id } }, externalTrId: Not(IsNull()) },
          select: ['externalTrId'],
        })
      )?.externalTrId ??
      undefined;

    const { validStartDate, validEndDate } = this.resolveValidDates(orderDelivery);
    return ExternalApiResponse.success<OrderLookupResponseData>({
      found: true,
      trId: responseTrId,
      orderStatus: order.status,
      couponStatus: this.toExternalCouponStatus(orderDelivery.couponStatus),
      deliveryStatus: await this.resolveDeliveryStatusWithSendHistory(orderDelivery),
      barCode: orderDelivery.barCode || undefined,
      personalCode: orderDelivery.personalCode || undefined,
      validStartDate,
      validEndDate,
    });
  }

  /**
   * 발송 결과 판정(reconcile 정직성 #3). 명시적 실패는 FAIL, actualSendAt 있으면 SUCCESS.
   * 완료 전이 전(크래시 윈도우, actualSendAt 미백필)이라도 연결된 발송 성공 이력이 있으면 SUCCESS —
   * dispatchSend 가 delivery_send_history(isSuccess=true, order_delivery_id)를 발송 직후 커밋하기 때문.
   */
  private async resolveDeliveryStatusWithSendHistory(
    orderDelivery: OrderDeliveryEntity,
  ): Promise<ExternalDeliveryStatus> {
    if (orderDelivery.status === IOrderDeliveryStatus.FAIL || orderDelivery.status === IOrderDeliveryStatus.FAIL_SMS) {
      return ExternalDeliveryStatus.FAIL;
    }
    if (orderDelivery.actualSendAt) {
      return ExternalDeliveryStatus.SUCCESS;
    }
    const sent = await this.deliverySendHistoryRepository.findOne({
      where: { orderDeliveryId: orderDelivery.id, isSuccess: true },
    });
    return sent ? ExternalDeliveryStatus.SUCCESS : ExternalDeliveryStatus.FAIL;
  }

  /**
   * requireExternalOrderId 앱은 externalOrderId 누락 시 거절(이중발급 방어선 강제).
   */
  private assertExternalOrderIdIfRequired(ctx: ApiRequestContext, externalOrderId: string | undefined): void {
    if (ctx.apiApp.requireExternalOrderId && !externalOrderId?.trim()) {
      throw new ExternalApiException('2001', '잘못된 요청', 'externalOrderId 필수 (외부 주문번호 필수 모드)');
    }
  }

  // ─── 주문 취소 ──────────────────────────────────────────

  /**
   * 변형 lease 획득 — 원자적 CAS. 비었거나 stale(5분 초과)일 때만 획득.
   * 재발행(execHistory DISCARD_REISSUE)·내부 폐기(execDiscard)와 같은 컬럼을 공유해
   * "서로 다른 행위의 교차"(재발행 중 취소 등)를 입구에서 차단한다(D3-55 후속).
   * claimedAt(발송배치 lease)과 별개 — 배치는 stale 정책이 없고 부팅 sweep 이
   * WAIT+claimedAt 을 무조건 해제하므로 겸용 시 살아있는 점유가 강탈·삭제된다.
   */
  private async acquireMutationLease(orderDeliveryId: number, claimAt: Date): Promise<boolean> {
    const staleThreshold = new Date(claimAt.getTime() - MUTATION_CLAIM_STALE_MS);
    const result = await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({ mutationClaimedAt: claimAt })
      .where('id = :id', { id: orderDeliveryId })
      // 컷오버 드레이닝·전환 건은 legacy 변형 lease 를 잡지 못한다(§9 quiesce).
      .andWhere(NOT_CUTOVER_ORDER_DELIVERY)
      .andWhere('(mutationClaimedAt IS NULL OR mutationClaimedAt < :stale)', { stale: staleThreshold })
      .execute();
    return !!result.affected;
  }

  /** 변형 lease 해제 (owner guard) — 내 lease 만 해제, 실패는 로깅만(stale self-heal 이 안전망). */
  private async releaseMutationLease(orderDeliveryId: number, claimAt: Date): Promise<void> {
    try {
      await this.orderDeliveryRepository.update(
        { id: orderDeliveryId, mutationClaimedAt: claimAt },
        { mutationClaimedAt: null },
      );
    } catch (releaseErr) {
      this.logger.error(`[변형lease] 해제 실패 — orderDeliveryId=${orderDeliveryId}`, releaseErr);
    }
  }

  async reconcileOpenCancelIntents(limit = 50): Promise<void> {
    const intents = await this.deliveryCancelIntentService.findOpen(DeliveryCancelIntentSource.EXTERNAL_API, limit);
    for (const intent of intents) {
      try {
        await this.reconcileCancelIntent(intent);
      } catch (error) {
        await this.deliveryCancelIntentService.markReconciling(
          intent.id,
          `EXTERNAL_RECONCILE_FAILED:${this.safeErrorMessage(error)}`,
        );
        this.logger.error(
          `[CANCEL_INTENT] 외부 API 재조정 실패. intentId=${intent.id}, orderDeliveryId=${intent.orderDeliveryId}`,
          error,
        );
      }
    }
  }

  private async reconcileCancelIntent(intent: DeliveryCancelIntentEntity): Promise<void> {
    const acquired = await this.deliveryWorkflowSlotService.acquire({
      orderDeliveryId: intent.orderDeliveryId,
      op: DeliveryExclusiveOp.DISCARD,
    });
    if (!acquired.acquired) {
      return;
    }

    const slot = acquired.slot;
    let slotOwned = true;
    try {
      const claimed = await this.deliveryCancelIntentService.claimForReconcile(intent.id, slot);
      let status = this.deliveryCancelIntentService.effectiveStatus(claimed);
      const orderDelivery = await this.orderDeliveryRepository.findOne({
        where: { id: intent.orderDeliveryId },
        relations: [
          'orderProductMapping',
          'orderProductMapping.order',
          'orderProductMapping.product',
          'orderProductMapping.product.partnerCompany',
          'choiceSelectProduct',
          'choiceSelectProduct.partnerCompany',
        ],
      });
      if (!orderDelivery) {
        throw new Error(`cancel intent delivery not found: ${intent.orderDeliveryId}`);
      }

      const order = orderDelivery.orderProductMapping.order;
      const billingUserId = order.clientUserId ?? order.userId;
      const billingUser = await this.userRepository.findOne({
        where: { id: billingUserId },
        relations: ['company'],
      });
      if (!billingUser) {
        throw new Error(`cancel intent billing user not found: ${billingUserId}`);
      }
      const account = { user: billingUser } as ExternalApiAccountEntity;

      if (status === DeliveryCancelIntentStatus.PENDING) {
        const product = orderDelivery.orderProductMapping.product;
        if (orderDelivery.barCode && product?.partnerCompany) {
          const refreshed = await this.partnerCompanyExternService.refreshCouponStatus(orderDelivery);
          if (refreshed.couponStatus === OrderDeliveryCouponStatus.NOT_USED) {
            await this.partnerCompanyExternService.cancelByExternalApi(orderDelivery);
          } else if (
            refreshed.couponStatus !== OrderDeliveryCouponStatus.CANCEL &&
            refreshed.couponStatus !== OrderDeliveryCouponStatus.REFUND_CANCEL
          ) {
            throw new Error(`partner cancellation cannot resume from: ${refreshed.couponStatus ?? 'UNKNOWN'}`);
          }
        }
        await this.deliveryCancelIntentService.markExternalCancelled(claimed.id, slot);
        status = DeliveryCancelIntentStatus.CANCEL_CONFIRMED;
      }

      if (status === DeliveryCancelIntentStatus.CANCEL_CONFIRMED) {
        await this.processCutoverCancelRefund(order, orderDelivery, account, slot, claimed.id);
        slotOwned = false;
        return;
      }

      if (status === DeliveryCancelIntentStatus.DB_APPLIED) {
        if (!(await this.deliveryWorkflowSlotService.release(slot))) {
          throw new Error(`cancel intent DISCARD slot release failed: ${claimed.id}`);
        }
        slotOwned = false;
        await this.executeCutoverCancelRefund(order, orderDelivery, account, claimed.id);
      }
    } finally {
      if (slotOwned) {
        await this.deliveryWorkflowSlotService.release(slot);
      }
    }
  }

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

    const isCutover = await this.cutoverGuard.isCutover(orderDelivery.id);
    let discardSlot: DeliverySlot | null = null;
    let mutationClaimAt: Date | null = null;
    let cancelIntentId: string | null = null;

    if (isCutover) {
      const acquired = await this.deliveryWorkflowSlotService.acquire({
        orderDeliveryId: orderDelivery.id,
        op: DeliveryExclusiveOp.DISCARD,
      });
      if (!acquired.acquired) {
        throw new ExternalApiException('3010', '해당 주문에 다른 처리가 진행 중입니다. 잠시 후 다시 시도해 주세요.');
      }
      discardSlot = acquired.slot;
    } else {
      await this.cutoverGuard.assertLegacyAllowed(
        orderDelivery.id,
        LegacyDeliveryEntryPoint.EXTERNAL_API_CANCEL_REFUND,
      );
      mutationClaimAt = new Date();
      if (!(await this.acquireMutationLease(orderDelivery.id, mutationClaimAt))) {
        throw new ExternalApiException('3010', '해당 주문에 다른 처리가 진행 중입니다. 잠시 후 다시 시도해 주세요.');
      }
      orderDelivery.mutationClaimedAt = mutationClaimAt;
    }
    try {
      // lease 획득 전 스냅샷은 stale 일 수 있다(직전까지 진행되던 재발행이 barCode/couponStatus 를 갱신).
      // 아래 가드와 "barCode 있으면 협력사 취소" 판단이 옛 값으로 내려가지 않도록 volatile 컬럼을 재조회한다.
      //
      // fail-closed: 재조회가 비면 반드시 거절한다. stale 스냅샷으로 진행하면 barCode=null(미발급 시점 값) 때문에
      // 협력사 취소를 건너뛴 채 환불만 나가 "협력사엔 살아있는 핀 + DB 는 CANCEL + 환불 완료" 자금 사고가 된다.
      // 행이 사라지는 경로가 실재한다 — 재발행 실패 시 unwindReissue 가 tip 을 softDelete 한다(기본 조회에서 제외).
      const fresh = await this.orderDeliveryRepository.findOne({
        where: { id: orderDelivery.id },
        select: ['id', 'status', 'couponStatus', 'expireAt', 'barCode', 'discardedAt'],
      });
      if (!fresh) {
        this.logger.error(
          `[cancelOrder] lease 획득 후 재조회 실패(행 없음/soft-delete) — 취소 거절. orderDeliveryId=${orderDelivery.id}, trId=${trId}`,
        );
        throw new ExternalApiException('3010', '해당 주문에 다른 처리가 진행 중입니다. 잠시 후 다시 시도해 주세요.');
      }
      orderDelivery.status = fresh.status;
      orderDelivery.couponStatus = fresh.couponStatus;
      orderDelivery.expireAt = fresh.expireAt;
      orderDelivery.barCode = fresh.barCode;
      orderDelivery.discardedAt = fresh.discardedAt;

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

      if (discardSlot) {
        const cancelIntent = await this.deliveryCancelIntentService.create(
          orderDelivery.id,
          DeliveryCancelIntentSource.EXTERNAL_API,
          discardSlot,
          {
            requestedCouponStatus: OrderDeliveryCouponStatus.CANCEL,
            refundRequired: true,
            requestedByUserId: order.clientUserId ?? order.userId,
            expectedRefundAmount: order.settleAmount,
            expectedRefundScope: RefundScope.FULL,
          },
        );
        cancelIntentId = cancelIntent.id;
      }

      if (orderDelivery.barCode && product?.partnerCompany) {
        try {
          await this.partnerCompanyExternService.cancelByExternalApi(orderDelivery);
        } catch (error) {
          this.logger.error(`[cancelOrder] 쿠폰 취소 실패 - trId: ${trId}`, error);
          throw translatePartnerError(error, 'cancel');
        }
      }
      if (discardSlot && cancelIntentId) {
        await this.deliveryCancelIntentService.markExternalCancelled(cancelIntentId, discardSlot);
      }

      if (discardSlot) {
        await this.processCutoverCancelRefund(order, orderDelivery, account, discardSlot, cancelIntentId!);
        discardSlot = null;
      } else {
        await this.processCancelRefund(order, orderDelivery, account, mutationClaimAt!);
      }

      return ExternalApiResponse.success();
    } catch (error) {
      if (cancelIntentId) {
        await this.deliveryCancelIntentService.markReconciling(
          cancelIntentId,
          `EXTERNAL_CANCEL_FLOW_FAILED:${this.safeErrorMessage(error)}`,
        );
      }
      throw error;
    } finally {
      if (discardSlot) {
        await this.deliveryWorkflowSlotService.release(discardSlot);
      }
      if (mutationClaimAt) {
        await this.releaseMutationLease(orderDelivery.id, mutationClaimAt);
      }
    }
  }

  @Transactional()
  private async processCancelRefund(
    order: OrderEntity,
    orderDelivery: OrderDeliveryEntity,
    account: ExternalApiAccountEntity,
    /** cancelOrder 가 획득한 변형 lease 토큰. 상태 쓰기의 fencing 조건으로 쓴다(다음 커밋). */
    mutationClaimAt: Date,
  ) {
    // 컷오버 전환 건 거부(§9 인벤토리 #7). 취소 사유는 workflow `CANCELLED` 전이 후 REFUND(경로 B)로
    // 처리한다. 협력사 취소는 이 함수 진입 전에 끝나므로, 이 거부는 **취소 API 최상단 가드**(cancelOrder)
    // 와 짝을 이룰 때만 의미가 있다 — 그래서 cancelOrder 진입부에서도 같은 게이트를 통과시킨다.
    await this.cutoverGuard.assertLegacyAllowed(orderDelivery.id, LegacyDeliveryEntryPoint.EXTERNAL_API_CANCEL_REFUND);

    const discardedAt = new Date();
    orderDelivery.status = IOrderDeliveryStatus.CANCEL;
    orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;
    orderDelivery.discardedAt = discardedAt;

    // save(orderDelivery) 금지 — merge 는 **행 전체**를 메모리 스냅샷으로 UPDATE 한다 (D3-60 clobber).
    // orderDelivery 는 findOrderDeliveryByTrId 가 로드한 full 엔티티이고, cancelOrder 의 lease 획득 후
    // 재조회는 status/couponStatus/expireAt/barCode/discardedAt **6개만** 갱신한다.
    // 나머지 컬럼(imagePath·actualSendAt·encourageAt·reportState·alimTalkMsgKey·personalCode·
    // couponNum·deletedAt …)은 trId 조회 시점의 옛 값 그대로라, save 는 그 사이 배치·재발행이 쓴
    // 값을 되돌린다. 특히 deletedAt=NULL 되돌림은 unwindReissue 가 지운 tip 을 부활시킨다.
    // 이 함수가 실제로 바꾸는 3개 컬럼만 targeted update 한다.
    //
    // fencing: 내 변형 lease 를 아직 들고 있을 때만 쓴다.
    // lease 는 5분 stale self-heal 이라, 협력사 취소가 극단 지연되면(재시도 최대 31초 + 응답 대기)
    // 그 사이 폐기·재발행이 lease 를 stale 로 보고 가져갈 수 있다. 그때 무조건 쓰면 남이 확정한
    // 상태를 덮는다.
    const claimed = await this.orderDeliveryRepository.update(
      { id: orderDelivery.id, mutationClaimedAt: mutationClaimAt },
      {
        status: IOrderDeliveryStatus.CANCEL,
        couponStatus: OrderDeliveryCouponStatus.CANCEL,
        discardedAt,
      },
    );

    // affected=0 = lease 를 뺏긴 뒤였다. 여기서 멈추면 안 된다 —
    // 협력사 취소(cancelByExternalApi)는 **이 함수에 오기 전에 이미 끝난 비가역 작업**이라,
    // 중단하면 "협력사 쿠폰은 죽었는데 환불은 안 나간" 고객 피해가 남는다.
    // 따라서 환불은 그대로 집행하고(refundLedger.claim 의 멱등 게이트가 이중환불을 막는다 — D3-3),
    // 상태 미반영만 경보로 남겨 수동 정합을 유도한다.
    if (!claimed.affected) {
      this.logger.error(
        `[CANCEL_FENCE_LOST] 변형 lease 상실로 취소 상태 미반영 — 환불은 진행한다. ` +
          `orderDeliveryId=${orderDelivery.id}, orderId=${order.id}, ` +
          `수동 확인 필요: order_delivery.status/coupon_status 가 CANCEL 인지 대조`,
      );
    }

    order.status = IOrderStatus.DELIVERY_CANCEL;
    await this.orderRepository.save(order);

    await this.executeCancelRefund(order, orderDelivery, account);
  }

  private async processCutoverCancelRefund(
    order: OrderEntity,
    orderDelivery: OrderDeliveryEntity,
    account: ExternalApiAccountEntity,
    slot: DeliverySlot,
    cancelIntentId: string,
  ): Promise<void> {
    const discardedAt = new Date();
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(OrderDeliveryEntity).update(
        { id: orderDelivery.id },
        {
          status: IOrderDeliveryStatus.CANCEL,
          couponStatus: OrderDeliveryCouponStatus.CANCEL,
          discardedAt,
        },
      );
      await manager.getRepository(OrderEntity).update({ id: order.id }, { status: IOrderStatus.DELIVERY_CANCEL });
      const transitioned = await manager
        .getRepository(DeliveryWorkflowEntity)
        .createQueryBuilder()
        .update(DeliveryWorkflowEntity)
        .set({
          workflowStatus: DeliveryWorkflowStatus.CANCELLED,
          stateEnteredAt: discardedAt,
          activeExclusiveOp: null,
          exclusiveOwnerToken: null,
          exclusiveLeaseExpiresAt: null,
          workflowVersion: () => 'workflow_version + 1',
        })
        .where('order_delivery_id = :orderDeliveryId', { orderDeliveryId: orderDelivery.id })
        .andWhere('active_exclusive_op = :op', { op: DeliveryExclusiveOp.DISCARD })
        .andWhere('exclusive_owner_token = :ownerToken', { ownerToken: slot.ownerToken })
        .andWhere('workflow_version = :workflowVersion', { workflowVersion: slot.workflowVersion })
        .execute();
      if (!transitioned.affected) {
        throw new ExternalApiException('3010', '취소 처리 소유권이 만료되었습니다. 다시 시도해 주세요.');
      }
      await this.deliveryCancelIntentService.markDbApplied(cancelIntentId, slot, manager, discardedAt);
    });

    orderDelivery.status = IOrderDeliveryStatus.CANCEL;
    orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;
    orderDelivery.discardedAt = discardedAt;
    order.status = IOrderStatus.DELIVERY_CANCEL;

    await this.executeCutoverCancelRefund(order, orderDelivery, account, cancelIntentId);
  }

  private async executeCutoverCancelRefund(
    order: OrderEntity,
    orderDelivery: OrderDeliveryEntity,
    account: ExternalApiAccountEntity,
    cancelIntentId: string,
  ): Promise<void> {
    const intent = await this.deliveryCancelIntentService.getRequired(cancelIntentId);
    if (intent.expectedRefundAmount !== order.settleAmount || intent.expectedRefundScope !== RefundScope.FULL) {
      throw new Error(`cancel intent refund expectation mismatch: ${cancelIntentId}`);
    }
    const boundAttempt = intent.refundAttemptId
      ? await this.refundAttemptExecutor.findBoundAttempt({
          attemptId: intent.refundAttemptId,
          orderDeliveryId: orderDelivery.id,
          amount: intent.expectedRefundAmount,
          scope: RefundScope.FULL,
        })
      : null;
    if (intent.refundAttemptId && !boundAttempt) {
      throw new Error(`cancel intent refund attempt binding mismatch: ${cancelIntentId}`);
    }
    if (boundAttempt?.status === RefundAttemptStatus.SUCCEEDED) {
      await this.deliveryCancelIntentService.markRefundSucceeded(cancelIntentId, {
        attemptId: boundAttempt.id,
        orderDeliveryId: orderDelivery.id,
        amount: intent.expectedRefundAmount,
        scope: RefundScope.FULL,
      });
      return;
    }
    if (
      boundAttempt?.status === RefundAttemptStatus.CLAIMED ||
      boundAttempt?.status === RefundAttemptStatus.SUBMITTING ||
      boundAttempt?.status === RefundAttemptStatus.RECONCILING ||
      boundAttempt?.status === RefundAttemptStatus.UNKNOWN
    ) {
      const reconciledStatus = await this.refundAttemptExecutor.reconcile({
        attemptId: boundAttempt.id,
        orderDeliveryId: orderDelivery.id,
        amount: intent.expectedRefundAmount,
        scope: RefundScope.FULL,
        inspect: async () => await this.inspectExternalCancelRefund(boundAttempt, order, orderDelivery, account),
      });
      if (reconciledStatus === RefundAttemptStatus.SUCCEEDED) {
        await this.deliveryCancelIntentService.markRefundSucceeded(cancelIntentId, {
          attemptId: boundAttempt.id,
          orderDeliveryId: orderDelivery.id,
          amount: intent.expectedRefundAmount,
          scope: RefundScope.FULL,
        });
      } else {
        await this.deliveryCancelIntentService.markReconciling(
          cancelIntentId,
          `REFUND_${reconciledStatus ?? 'LOCKED'}`,
        );
      }
      return;
    }

    const refundResult = await this.refundAttemptExecutor.execute({
      orderDeliveryId: orderDelivery.id,
      amount: order.settleAmount,
      scope: RefundScope.FULL,
      externalIdempotencyKey: `external-cancel:${orderDelivery.id}:${ulid()}`,
      bindAttempt: async (attempt, manager) => {
        await this.deliveryCancelIntentService.bindRefundAttempt(cancelIntentId, attempt, manager);
      },
      execute: async (fencing) => {
        await this.executeCancelRefund(order, orderDelivery, account, fencing);
        return { status: RefundAttemptStatus.SUCCEEDED };
      },
    });
    if (refundResult.status === RefundAttemptStatus.SUCCEEDED) {
      await this.deliveryCancelIntentService.markRefundSucceeded(cancelIntentId, {
        attemptId: refundResult.attemptId,
        orderDeliveryId: orderDelivery.id,
        amount: order.settleAmount,
        scope: RefundScope.FULL,
      });
    } else {
      await this.deliveryCancelIntentService.markReconciling(cancelIntentId, `REFUND_${refundResult.status}`);
    }
  }

  private async inspectExternalCancelRefund(
    attempt: { id: string; amount: number },
    order: OrderEntity,
    orderDelivery: OrderDeliveryEntity,
    account: ExternalApiAccountEntity,
  ): Promise<
    { status: RefundAttemptStatus.SUCCEEDED } | { status: RefundAttemptStatus.FAILED; reason: string } | null
  > {
    const ledger = await this.refundLedgerService.findByAttempt(attempt.id, orderDelivery.id, attempt.amount);
    // ledger 는 실제 환불보다 먼저 커밋되므로 부재는 미실행 증거다(존재는 아직 성공 증거가 아니다).
    // 직전 실행이 커밋 전일 가능성은 executor 의 정지 판정이 막는다.
    if (!ledger) {
      return {
        status: RefundAttemptStatus.FAILED,
        reason: 'REFUND_LEDGER_NOT_CREATED',
      };
    }
    if (ledger.sourcePath !== 'EXTERNAL_CANCEL' || !ledger.ssgBalanceSettled) {
      return null;
    }

    const billingUser = await this.loadOrderBillingUser(order, account.user);
    const isWalletManaged = await this.walletManagedPredicate.isWalletManaged(order.id, this.dataSource.manager);
    if (isWalletManaged) {
      // 증거를 이 delivery 의 환불 멱등키 prefix 로 좁힌다. order + eventType + affectedDeliveryIds 만으로는
      // 과거의 다른 DISCARD_REFUND 이벤트가 이번 attempt 의 성공 증거로 통과한다.
      const events = await this.dataSource.manager
        .getRepository(OrderPaymentRefundEventEntity)
        .createQueryBuilder('event')
        .where('event.order_id = :orderId', { orderId: order.id })
        .andWhere('event.event_type = :eventType', {
          eventType: OrderPaymentRefundEventType.DISCARD_REFUND,
        })
        .andWhere('event.reversed_at IS NULL')
        .andWhere('event.idempotency_key LIKE :prefix', {
          prefix: `${this.walletRefundKeyPrefix('discard_refund', order, orderDelivery)}%`,
        })
        .andWhere(`JSON_CONTAINS(event.affected_delivery_ids, :deliveryId, '$')`, {
          deliveryId: JSON.stringify(orderDelivery.id),
        })
        .getMany();
      if (events.length === 0) {
        await this.refundViaWallet(
          billingUser,
          order,
          orderDelivery,
          OrderPaymentRefundEventType.DISCARD_REFUND,
          'discard_refund',
        );
      } else {
        this.assertRefundEvidenceAmount(
          events.reduce((sum, event) => sum + event.refundedGrossBase + event.refundedCardSurchargeAmount, 0),
          attempt,
          orderDelivery.id,
        );
      }
    } else {
      // legacy 는 멱등키가 결정론적이므로 정확히 그 키의 트랜잭션만 증거로 인정한다.
      const idempotencyKey = `legacy_discard_refund:${order.id}:${orderDelivery.id}:deposit`;
      const transaction = await this.dataSource.manager.getRepository(WalletTransactionEntity).findOne({
        where: {
          idempotencyKey,
          orderDeliveryId: orderDelivery.id,
          type: 'DISCARD_REFUND',
        },
      });
      if (!transaction) {
        await this.refundLegacyBalanceAndAudit({
          billingUser,
          order,
          orderDelivery,
          sourcePath: 'EXTERNAL_CANCEL',
          transactionType: 'DISCARD_REFUND',
          idempotencyKey,
          memo: `외부 API 취소 환불 (주문번호: ${order.id})`,
          refundLedgerId: ledger.id,
        });
      } else {
        this.assertRefundEvidenceAmount(transaction.amount, attempt, orderDelivery.id);
      }
    }

    return { status: RefundAttemptStatus.SUCCEEDED };
  }

  /** wallet 환불 이벤트 멱등키의 delivery 단위 prefix. 실행(refundViaWallet)과 증거 조회가 같은 규약을 쓴다. */
  private walletRefundKeyPrefix(
    kind: 'fail_refund' | 'discard_refund',
    order: OrderEntity,
    orderDelivery: OrderDeliveryEntity,
  ): string {
    return `${kind}:${order.id}:${orderDelivery.id}:`;
  }

  /**
   * 영구 증거(환불 이벤트·트랜잭션)의 금액이 attempt 가 지시한 환불액과 다르면 성공으로 확정하지 않는다.
   * 금액이 어긋난 증거로 SUCCEEDED 를 확정하면 attempt ↔ 실제 금전 부작용의 연결이 끊긴다.
   */
  private assertRefundEvidenceAmount(
    refundedAmount: number,
    attempt: { id: string; amount: number },
    orderDeliveryId: number,
  ): void {
    if (refundedAmount === attempt.amount) {
      return;
    }
    throw new Error(
      `refund evidence amount mismatch: refundAttemptId=${attempt.id} orderDeliveryId=${orderDeliveryId} ` +
        `expected=${attempt.amount} actual=${refundedAmount}`,
    );
  }

  private async executeCancelRefund(
    order: OrderEntity,
    orderDelivery: OrderDeliveryEntity,
    account: ExternalApiAccountEntity,
    refundExecution?: ExecuteRefundContext,
  ): Promise<void> {
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
      refundExecution,
    });

    const refundLedgerId = await this.refundLedgerService.getLedgerId(orderDelivery.id);
    if (isWalletManaged) {
      await this.refundViaWallet(
        billingUser,
        order,
        orderDelivery,
        OrderPaymentRefundEventType.DISCARD_REFUND,
        'discard_refund',
      );
      return;
    }

    await this.refundLegacyBalanceAndAudit({
      billingUser,
      order,
      orderDelivery,
      sourcePath: 'EXTERNAL_CANCEL',
      transactionType: 'DISCARD_REFUND',
      idempotencyKey: `legacy_discard_refund:${order.id}:${orderDelivery.id}:deposit`,
      memo: `외부 API 취소 환불 (주문번호: ${order.id})`,
      refundLedgerId,
    });
  }

  // ─── 재발송 ─────────────────────────────────────────────

  async resendOrder(
    account: ExternalApiAccountEntity,
    trId: string,
    ctx: ApiRequestContext,
  ): Promise<ExternalApiResponse> {
    const orderDelivery = await this.findOrderDeliveryByTrId(account, trId, ctx);
    const order = orderDelivery.orderProductMapping?.order;

    // D3-55 후속: 재발행 진행 중 tip 은 변형 lease 를 보유한다. 아래 슬롯 CAS 의 WHERE 에
    // lease 조건을 포함해, 재발행 자체 발송과의 이중 발송을 원자적으로 차단한다(활성 lease → 3010).

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

    // ─ Atomic slot claim + 변형 lease 획득 ─
    // 동시 이중 발송(발송 비용 중복)과 resendCount 손실 race 를 차단하기 위해,
    // 외부 발송 전에 DB 에서 원자적으로 슬롯을 선점한다 (read-then-write save 금지).
    // WHERE 에 couponStatus 가드를 포함해 SELECT~UPDATE 사이의 취소/폐기 race 도 닫는다.
    //
    // lease 는 "읽기"가 아니라 "획득"이어야 한다 — SET 에 mutationClaimedAt 을 포함해 슬롯 선점과 동시에
    // 잡는다. 읽기만 하면 dispatchSend(외부 발송, 수 초) 동안 lease 가 비어 있어, 그 사이 폐기/취소가
    // 진입해 협력사 취소 + 환불을 마치고, 이 재발송은 이미 죽은 핀을 고객에게 배달하게 된다.
    // stale(5분 초과) lease 는 크래시 잔재로 보고 강탈한다(self-heal).
    const mutationClaimAt = new Date();
    const mutationStale = new Date(mutationClaimAt.getTime() - MUTATION_CLAIM_STALE_MS);
    const claim = await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({ resendCount: () => 'resend_count + 1', mutationClaimedAt: mutationClaimAt })
      .where('id = :id', { id: orderDelivery.id })
      .andWhere('resend_count < :max', { max })
      .andWhere('coupon_status NOT IN (:...blocked)', {
        blocked: [OrderDeliveryCouponStatus.CANCEL, OrderDeliveryCouponStatus.REFUND_CANCEL],
      })
      .andWhere('(mutation_claimed_at IS NULL OR mutation_claimed_at < :mutationStale)', { mutationStale })
      // 컷오버 드레이닝·전환 건은 legacy 재발송 슬롯을 잡지 못한다(§9 quiesce).
      .andWhere(NOT_CUTOVER_ORDER_DELIVERY)
      .execute();

    if (!claim.affected) {
      // 한도 도달 / 직전 취소·폐기 / 변형 작업 진행중. 최신 상태로 정확히 분기.
      const fresh = await this.orderDeliveryRepository.findOne({
        where: { id: orderDelivery.id },
        select: ['resendCount', 'couponStatus', 'mutationClaimedAt'],
      });
      if (
        fresh?.couponStatus === OrderDeliveryCouponStatus.CANCEL ||
        fresh?.couponStatus === OrderDeliveryCouponStatus.REFUND_CANCEL
      ) {
        throw new ExternalApiException('3005', '폐기/취소된 쿠폰은 재발송 불가');
      }
      if (fresh?.mutationClaimedAt && fresh.mutationClaimedAt >= mutationStale) {
        throw new ExternalApiException('3010', '해당 주문에 다른 처리가 진행 중입니다. 잠시 후 다시 시도해 주세요.');
      }
      throw new ExternalApiException('3008', `재발송 횟수 초과 (${fresh?.resendCount ?? max}/${max})`);
    }
    // 메모리 엔티티에도 반영 — 이후 누군가 save(merge) 해도 자기 lease 를 NULL 로 되돌리지 않도록.
    orderDelivery.mutationClaimedAt = mutationClaimAt;

    try {
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
      // dispatchSend 가 in-memory 로 갱신한 발송 상태만 targeted update + fencing(내 lease 일 때만).
      const sendWrite = await this.orderDeliveryRepository.update(
        { id: orderDelivery.id, mutationClaimedAt: mutationClaimAt },
        {
          resendAt: new Date(),
          status: orderDelivery.status,
          actualSendAt: orderDelivery.actualSendAt,
        },
      );
      if (!sendWrite.affected) {
        // affected=0 = 발송(외부 통신, 수 초) 도중 폐기/취소가 lease 를 탈취했다
        // = **방금 보낸 핀은 협력사에서 취소되고 환불까지 됐을 수 있다**.
        // 여기서 success() 를 주면 파트너는 발송 성공으로 알고, 고객은 죽은 핀을 받고,
        // resendAt/actualSendAt 은 갱신 안 된 채 로그 한 줄만 남는다. → 3010(CONFLICT).
        //
        // ★ "주문 상태를 다시 조회해 주세요" 라고 하면 안 된다 (리뷰 MEDIUM).
        //   getOrderStatus 의 toExternalCouponStatus 는 USED/EXPIRED/REFUND_CANCEL 을 전부
        //   ISSUED 로 축약한다(의도된 설계, D3-54). 즉 이 상황에서 재조회하면 **정상으로 보인다**.
        //   우리가 유도한 확인 행동이 문제를 못 드러내고 오히려 안심시킨다.
        //
        // ★ 재발송 슬롯(resend_count)은 반납하지 않는다.
        //   위 catch 의 롤백은 "발송이 실패했으니 시도를 무르는" 것인데, 여기는 발송이
        //   **성공**했다(문자가 고객에게 나갔다). 슬롯은 소비된 게 맞다.
        this.logger.error(
          `[resendOrder] 발송결과 기록 실패 — 변형 lease 상실(다른 처리가 선점). ` +
            `문자는 이미 발송됐으나 해당 쿠폰이 취소·환불됐을 수 있다. 운영 확인 필요. ` +
            `orderDeliveryId=${orderDelivery.id}, trId=${trId}`,
        );
        throw new ExternalApiException(
          '3010',
          '재발송 문자는 발송되었으나, 그 사이 해당 주문이 취소·폐기되었을 수 있습니다. ' +
            '조회 API 로는 확인되지 않으니 담당자에게 문의해 주세요.',
        );
      }

      return ExternalApiResponse.success();
    } finally {
      await this.releaseMutationLease(orderDelivery.id, mutationClaimAt);
    }
  }

  /**
   * 재발송 슬롯 롤백 — 발송 실패 시 선점한 슬롯 1개 반납 (음수 방지).
   *
   * WHERE 는 { id } 뿐이며 **일부러 lease fencing 을 하지 않는다** (리뷰 P1).
   * resend_count 는 소유자 구분 없는 fungible 카운터라, 각 요청은 claim 에서 +1 하고
   * 자기 발송이 실패했을 때만 -1 한다. 이 -1 은 "자기 자신의 +1 을 되돌리는" 것이므로,
   * 그 사이 lease 가 남에게 탈취됐어도 무조건 실행돼야 카운트가 정확히 유지된다.
   * 여기에 `AND mutation_claimed_at = :myToken` 을 붙이면 탈취당한 실패 요청이 affected=0 으로
   * 자기 슬롯을 못 돌려줘 영구 누수 → resend_count 가 max 까지 차 정상 재발송이 막힌다.
   * (fencing 이 옳은 곳은 releaseMutationLease — "내 lease 만 해제". 슬롯 반납은 반대다.)
   * 회귀 잠금: external.api.resend-slot.spec.ts "WHERE 는 { id } 뿐 — lease/상태 fencing 없음".
   */
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

    // externalOrderId 필수 모드: 이중발급 방어선(UNIQUE order_axis) 강제.
    this.assertExternalOrderIdIfRequired(ctx, dto.externalOrderId);

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
      ctx.apiApp.requireExternalCustomerId,
    );
    const sendAmount = dto.amount;

    // 요청 금액과 일치하는 SSG 상품을 확정(없으면 템플릿으로 생성).
    // 내부 admin /order/ssg 흐름과 동일한 resolver를 사용해 sendAmount === product.price 보장.
    const product = await this.productService.findOrCreateSsgProductByPrice(sendAmount).catch(() => {
      throw new ExternalApiException('3001', 'SSG 상품 없음');
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
      { cardSurchargeApplied: await this.resolveCardSurchargeAppliedForUser(billingUser) },
    );

    // senderPhone 미지정 SSG 알림톡 → 자사 대표번호로 확정 (검증/저장 동일값)
    const effectiveSenderPhone = dto.senderPhone ?? systemFromPhoneNumber;

    // 발신번호 SoT 검증(차감 전, flag gating). 차감은 아래 order 그래프 저장 후 wallet/legacy 분기에서 수행.
    if (process.env.FROM_PHONE_SOT_ENFORCE === 'true') {
      await this.orderFromService.assertApprovedPhones(billingUser.id, [
        { sendMethod: IOrderSendMethod.ALIM_TALK, fromPhoneNumber: effectiveSenderPhone },
      ]);
    }

    const order = this.orderRepository.create({
      userId: user.id,
      code: createTempOrderCode(),
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

    // 2-step 채번: id 확정 후 EPEVT 코드로 확정(같은 트랜잭션 → 임시코드 커밋 전 소멸)
    order.code = deriveOrderCodeFromId(order.id);
    await this.orderRepository.save(order);

    const ssgLineSnapshot = buildLineProductSnapshot(product);
    const mapping = this.orderProductMappingRepository.create({
      orderId: order.id,
      productId: product.id,
      // ⚠️ D3-53 전제: 외부 SSG주문도 단일라인(sendAmount === product.price 보장, 위 findOrCreateSsgProductByPrice).
      //    amount 가 1 이 아니게 되면 sendAmount 가 '총액'이 되어 getSsgOrderStatus price(단가) 의미가 바뀐다 → 수량 도입 시 재검토.
      amount: 1,
      sendContent: dto.message || '',
      sendTitle: product.name,
      fromPhoneNumber: effectiveSenderPhone,
      sendMethod: IOrderSendMethod.ALIM_TALK,
      fee,
      priceAdjustment,
      topImagePath: '',
      midImagePath: '',
      ...ssgLineSnapshot,
      ...buildPartnerSettleSnapshot(product, ssgLineSnapshot.snapshotProductPrice ?? product.price),
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
    const root = await this.orderDeliveryRepository.findOne({
      where: { externalTrId: trId },
      relations: EXTERNAL_ORDER_DELIVERY_RELATIONS,
    });

    if (!root) {
      throw new ExternalApiException('4001', '주문을 찾을 수 없음');
    }

    // D3-55: 폐기 후 재발행 시 trId(externalTrId)는 폐기된 원본(root)에 남고,
    // 새로 발급된 유효 delivery 는 externalTrId=null 이 된다. 파트너의 trId 가
    // 죽은 원본을 가리키지 않도록, 재발행 체인(replacedFromId)의 살아있는 최신 delivery 로 이동한다.
    const orderDelivery = await this.resolveActiveDelivery(root);

    const order = orderDelivery.orderProductMapping?.order;
    if (!order) {
      throw new ExternalApiException('4002', '주문에 대한 접근 권한 없음');
    }
    // PR2 소유권: apiAppId 기준 3분기(공통 헬퍼로 추출).
    this.assertOrderOwnership(order, account, ctx);

    return orderDelivery;
  }

  /**
   * 폐기 후 재발행(replacedFromId) 체인을 따라 살아있는 최신 delivery(tip)로 이동한다.
   * - trId 는 최초 createOrder delivery(체인의 root)에만 심기므로, 재발행 시 신 delivery(externalTrId=null)가
   *   조회/취소/재발송의 대상이 되도록 root → tip 으로 forward-hop 한다.
   * - 판정 기준(replacedFromId)은 정산(settle-fee.util calculateMappingSettlementBaseAmount)과 동일 SoT.
   *   (내부 주문조회 order.service.hideDiscardReissueDeliveries 는 같은 체인을 **반대 방향**으로 해석해
   *    root 만 남기고 tip 을 숨긴다 — 여기는 외부 파트너용이라 살아있는 tip 으로 전진. 재발행 의미 변경 시 양쪽 동기화 필요.)
   * - 게이트는 couponStatus 가 아니라 discardedAt 으로 한다. 폐기 원본의 couponStatus 는 stale sync
   *   (예: Galaxia push 로 CANCEL→USED)로 드리프트할 수 있으나, discardedAt 은 폐기 시에만 세팅되고
   *   운영 경로에서 null 로 리셋되지 않는 안정 마커라, 재발행 여부 판정이 상태 드리프트에 영향받지 않는다.
   */
  private async resolveActiveDelivery(root: OrderDeliveryEntity): Promise<OrderDeliveryEntity> {
    // 폐기된 적 없으면(discardedAt=null) 재발행된 적도 없음 → root 가 곧 tip.
    if (root.discardedAt == null) {
      return root;
    }

    // 같은 매핑의 형제 발송건 (체인 판정용 최소 컬럼만).
    const siblings = await this.orderDeliveryRepository.find({
      where: { orderProductMappingId: root.orderProductMappingId },
      select: ['id', 'replacedFromId'],
    });

    // 원본 id → 그 원본을 대체한 delivery id. bigint 는 런타임에 string 으로 hydrate 될 수 있어 Number 정규화.
    // 정상 데이터에선 한 원본을 대체하는 행이 1개뿐이라 유일. 이상 데이터(같은 원본을 가리키는 행이
    // 복수로 갈라진 체인)에선 max id 로 결정적이되 "살아있는 가지"를 보장하진 못한다(그런 데이터는 발생
    // 불가 전제 — 재발행은 원본을 CANCEL 로 폐기 후 1건만 생성). 완벽한 분기 추적은 범위 밖(알려진 제약).
    const replacedByMap = new Map<number, number>();
    for (const sibling of siblings) {
      if (sibling.replacedFromId == null) {
        continue;
      }
      const fromId = Number(sibling.replacedFromId);
      const existing = replacedByMap.get(fromId);
      if (existing == null || sibling.id > existing) {
        replacedByMap.set(fromId, sibling.id);
      }
    }

    // root 에서 시작해 "나를 대체한 행"을 계속 따라가 더 이상 대체되지 않은 tip 을 찾는다.
    let currentId = root.id;
    const visited = new Set<number>([currentId]);
    while (replacedByMap.has(currentId)) {
      const nextId = replacedByMap.get(currentId)!;
      if (visited.has(nextId)) {
        break; // 방어적 순환 차단(정상 데이터에선 발생 불가).
      }
      visited.add(nextId);
      currentId = nextId;
    }

    if (currentId === root.id) {
      return root; // 재발행 없이 폐기된 원본 → root 가 tip. (DISCARDED 로 정상 응답)
    }

    // tip 으로 이동 — caller 가 기대하는 relations 로 재로딩.
    const tip = await this.orderDeliveryRepository.findOne({
      where: { id: currentId },
      relations: EXTERNAL_ORDER_DELIVERY_RELATIONS,
    });
    // 방금 sibling 목록에 있던 id 이므로 정상 도달 불가. 방어적으로 root 유지.
    return tip ?? root;
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
  private safeErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
