import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Repository, Like } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Transactional } from 'typeorm-transactional';
import { randomUUID } from 'crypto';
import { addDays, format, subDays } from 'date-fns';
import dayjs from 'dayjs';
import * as fsPromises from 'fs/promises';
import * as QRCode from 'qrcode';

import { applyReplaceCharacters } from '../../common/utils/replace-characters.util';
import { resolveExpireDays, couponTokenExpiry } from '../../common/utils/expire.util';
import { OrderEntity } from '../../entity/order.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { DESTROYED_AT_SOURCE, isDeliveryDestroyed } from '../../order/domain/destroyed.at.source';
import { OrderHistoryEntity } from '../../entity/order.history.entity';
import { OrderRealProductEntity } from '../../entity/order.real.product.entity';
import { OrderRealProductMappingEntity } from '../../entity/order.real.product.mapping.entity';
import { DeliverySendHistoryEntity } from '../../entity/delivery.send.history.entity';
import { EmailSendHistoryEntity } from '../../entity/email.send.history.entity';
import { UserEntity } from '../../entity/user.entity';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import {
  OrderDeliveryAttemptEntity,
  OrderDeliveryAttemptType,
  OrderDeliveryAttemptStatus,
} from '../../entity/order.delivery.attempt.entity';
import {
  OrderPaymentRefundEventEntity,
  OrderPaymentRefundEventType,
} from '../../entity/order.payment.refund.event.entity';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { ResendDeductService } from '../../wallet/application/resend-deduct.service';
import { DataSource, IsNull } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';

import { DeliveryAlimTalk } from '../interface/delivery.alim.talk';
import { IOrderDeliveryStatus } from '../interface/order.delivery.status';
import { MUTATION_CLAIM_STALE_MS, UNSENDABLE_COUPON_STATUSES } from '../interface/order.delivery.mutation.claim';
import { OrderDeliveryCouponStatus } from '../interface/order.delivery.coupon.status';
import { OrderDeliveryRefundStatusEnum } from '../interface/order.delivery.refund.status.enum';
import { PII_BEARING_HISTORY_TYPES } from '../../order/interface/order.history.pii.types';
import { IMailSend } from '../../mail/interface/mail-send';
import { ISmsSend, SmsSendOut } from '../../sms/interface/sms.send';
import { MessageAttemptService } from './message-attempt.service';
import { MessageResultReconcileService } from './message-result-reconcile.service';
import { DeliveryCutoverGuardService } from './delivery-cutover-guard.service';
import { LegacyDeliveryEntryPoint, NOT_CUTOVER_ORDER_DELIVERY } from '../interface/legacy.delivery.entry.point';
import { MessageAttemptChannel, MessageAttemptType } from '../interface/message.attempt.status';
import { DeliveryExclusiveOp } from '../interface/delivery.workflow.status';
import { computeNextAttemptAt, isWithinAllowedSendWindow } from '../domain/resend.schedule';
import { IOrderSendMethod } from '../../order/interface/order.send.method';
import { IOrderStatus } from '../../order/interface/order.status';
import { IOrderType } from '../../order/interface/order.type';
import {
  IOrderDeliveryReportState,
  REPORT_CLAIM_LEASE_MS,
  REPORT_MAX_INQUIRY_ATTEMPTS,
  REPORT_NEXT_DUE_MS,
  REPORT_SWEEP_BATCH_LIMIT,
} from '../interface/order.delivery.report.state';
import { IUserSettleCondition } from '../../user/interface/user.settle.condition';
import { SettleUserOrderDetailEnum } from '../../settle/interface/settle.user.order.detail';
import { calculateSettlementPrice } from '../../util/settle-fee.util';
import { IOrderRealProductStatus } from '../../order_real_product/interface/order.real.product.status';
import { IFileStorage } from '../../file/interface/file.storage';
import { IProductType } from '../../product/interface/product.type';

import { AlimTalkTemplate } from '../domain/alim.talk.template';
import { AlimTalkEncourageTemplate } from '../domain/alim.talk.encourage.template';
import { EmailEncourageTemplate } from '../domain/email.encourage.template';
import { EmailDeliveryTemplate } from '../domain/email.delivery.template';
import { smsEncourageTemplate } from '../domain/sms.encourage.template';
import { smsSsgShortTemplate } from '../domain/sms.ssg.template';
import { DeliveryTrackingStatus } from '../domain/delivery.tracking.status';
import { OrderEmailSendType } from '../../order/domain/order.email.send.type';
import { EmailType } from '../../mail/domain/email.type';
import { EmailCertifyExpireDay } from '../../const';
import { OrderFromService } from '../../order_from/application/order.from.service';
import { getBillingUserId } from '../../order/domain/order.billing-user.helper';

import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { OrderEncryptKey } from '../../order_receive/interface/order.encrypt.key';
import { generateRandomCode } from '../../user_find/domain/code.generate';
import { DeliveryTrackHttp } from '../infra/delivery.track.http';
import { DeliveryCreateCouponImage } from '../infra/delivery.create.coupon.image';

import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { SsgEventService } from '../../ssg_event/application/ssg.event.service';
import { UserManagementService } from '../../user_management/application/user.management.service';
import { DeliverySendService } from './delivery.send.service';
import { RefundLedgerService } from './refund-ledger.service';
import { SsgInsertStateService } from './ssg-insert-state.service';
import { SsgInsertState } from '../interface/ssg.insert.state';
import { SsgRefundResolverService } from './ssg-refund.resolver';
import { SsgRefundOutcome } from '../interface/ssg.refund.resolve';
import { WalletManagedPredicate } from '../../wallet/application/wallet-managed.predicate';
import { RefundPoolService } from '../../wallet/application/refund-pool.service';
import { LegacyWalletCreditSyncService } from '../../wallet/application/legacy-wallet-credit-sync.service';

@Injectable()
export class DeliveryBatchService {
  constructor(
    @InjectRepository(OrderEntity)
    private orderRepository: Repository<OrderEntity>,
    @InjectRepository(OrderRealProductEntity)
    private realProductOrderRepository: Repository<OrderRealProductEntity>,
    @InjectRepository(OrderRealProductMappingEntity)
    private realProductOrderMappingRepository: Repository<OrderRealProductMappingEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
    @InjectRepository(DeliverySendHistoryEntity)
    private deliverySendHistoryRepository: Repository<DeliverySendHistoryEntity>,
    @Inject('DeliveryAlimTalk')
    private deliveryAlimTalk: DeliveryAlimTalk,
    @Inject('IMailSend')
    private mailSend: IMailSend,
    @Inject('ISmsSend')
    private smsSend: ISmsSend,
    private messageAttemptService: MessageAttemptService,
    private messageResultReconcileService: MessageResultReconcileService,
    private deliveryTrackHttp: DeliveryTrackHttp,
    private cryptoCipher: CryptoCipher,
    private configService: ConfigService,
    @InjectRepository(EmailSendHistoryEntity)
    private emailSendHistoryRepository: Repository<EmailSendHistoryEntity>,
    @Inject('IFileStorage')
    private fileStorage: IFileStorage,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    @InjectRepository(SsgEventEntity)
    private ssgEventRepository: Repository<SsgEventEntity>,
    private partnerCompanyExternService: PartnerCompanyExternService,
    private ssgEventService: SsgEventService,
    private userManagementService: UserManagementService,
    private deliverySendService: DeliverySendService,
    private refundLedgerService: RefundLedgerService,
    private ssgRefundResolverService: SsgRefundResolverService,
    private ssgInsertStateService: SsgInsertStateService,
    private readonly walletManagedPredicate: WalletManagedPredicate,
    private readonly refundPoolService: RefundPoolService,
    private readonly resendDeductService: ResendDeductService,
    private readonly legacyWalletCreditSyncService: LegacyWalletCreditSyncService,
    @InjectRepository(OrderDeliveryAttemptEntity)
    private readonly orderDeliveryAttemptRepository: Repository<OrderDeliveryAttemptEntity>,
    @InjectRepository(OrderPaymentRefundEventEntity)
    private readonly orderPaymentRefundEventRepository: Repository<OrderPaymentRefundEventEntity>,
    @InjectRepository(OrderPaymentAllocationEntity)
    private readonly orderPaymentAllocationRepository: Repository<OrderPaymentAllocationEntity>,
    @InjectRepository(OrderHistoryEntity)
    private readonly orderHistoryRepository: Repository<OrderHistoryEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly orderFromService: OrderFromService,
    private readonly cutoverGuard: DeliveryCutoverGuardService,
  ) {}

  private readonly logger = new Logger('batch');

  // 동시 처리 수 (환경변수로 설정 가능, 기본값 5)
  private get concurrencyLimit(): number {
    return this.configService.get<number>('BATCH_DELIVERY_CONCURRENCY', 5);
  }

  /**
   * deliveryTarget 복호화 (실패 시 원본 반환)
   */
  private decryptDeliveryTarget(orderDelivery: OrderDeliveryEntity, fieldName: string = 'deliveryTarget'): string {
    const encryptedValue =
      fieldName === 'emailReceiverPhone' ? orderDelivery.emailReceiverPhone : orderDelivery.deliveryTarget;

    if (!encryptedValue) {
      return '';
    }

    try {
      return this.cryptoCipher.decryptDeliveryTarget(encryptedValue);
    } catch (error) {
      this.logger.error(`Failed to decrypt ${fieldName} for orderDelivery ${orderDelivery.id}: ${error}`);
      return encryptedValue;
    }
  }

  private markSendSuccess(orderDelivery: OrderDeliveryEntity, status: IOrderDeliveryStatus): void {
    this.deliverySendService.markSendSuccess(orderDelivery, status);
  }

  private assertChoiceProductNotDeletedForCsResend(orderDelivery: OrderDeliveryEntity): void {
    const product = orderDelivery.orderProductMapping.product;
    if (!product || (product.type === IProductType.CHOICE && product.deletedAt)) {
      throw new Error('삭제된 초이스 쿠폰은 재발송할 수 없습니다.');
    }
  }

  private markSendFail(orderDelivery: OrderDeliveryEntity, status: IOrderDeliveryStatus): void {
    this.deliverySendService.markSendFail(orderDelivery, status);
  }

  private logSendFail(odId: number, method: string, extra: Record<string, unknown>, err: unknown): void {
    const extraStr = Object.entries(extra)
      .map(([k, v]) => `${k}=${v ?? 'NULL'}`)
      .join(' ');
    this.logger.error(
      `발송 실패 odId=${odId} method=${method} ${extraStr} msg=${(err as Error)?.message ?? String(err)}`,
    );
  }

  /**
   * QR 코드 이미지 생성 및 업로드
   */
  private async generateQrCodeImage(url: string): Promise<string> {
    const qrCodeBuffer = await QRCode.toBuffer(url);
    const uuid = randomUUID();
    const fileName = `qr-codes/${uuid}.png`;
    const originalName = `${uuid}.png`;
    const fileUrl = await this.fileStorage.uploadImageFileWithBuffer(qrCodeBuffer, fileName, originalName);
    return fileUrl.url;
  }

  /**
   * 쿠폰 이미지 생성 및 경로 반환
   */
  private async createCouponImage(orderDelivery: OrderDeliveryEntity): Promise<string> {
    const product = orderDelivery.orderProductMapping.product;
    const partnerCompany = product.partnerCompany;

    // 유효기간: expireAt이 이미 설정되어 있으면 사용 (재발송 시 최초 발송 기준 유지)
    let expireDate: string | null = null;
    if (orderDelivery.expireAt) {
      expireDate = dayjs(orderDelivery.expireAt).format('YYYY. MM. DD');
    } else {
      const expireDay = resolveExpireDays(
        orderDelivery.orderProductMapping.galaxiaDuration ?? product.galaxiaDuration,
        product.expireDay,
        partnerCompany?.validityStartsNextDay,
      );
      expireDate = expireDay ? dayjs().add(expireDay, 'day').format('YYYY. MM. DD') : null;
    }

    const { path } = await DeliveryCreateCouponImage(
      product.imagePath,
      product.name,
      orderDelivery.barCode!,
      product.brand!.nameKorean,
      expireDate,
      orderDelivery.orderProductMapping.topImagePath,
      orderDelivery.orderProductMapping.midImagePath,
      product.type,
    );

    return path;
  }

  /**
   * 발송 실패 시 환불 처리 (SSG 이벤트 잔액 복원 + 사용자 잔액/정산 복원).
   * PIN 발급 실패, 메시지 발송 실패 등 delivery가 FAIL이 될 때 호출.
   *
   * 환불 라우팅:
   * - 정산확정 후(isSettleComplete=true) → 선입금(balance)으로 복원
   *   (한도 사용분도 정산확정 시 allSettleAmount가 이미 0으로 차감됐으므로 음수 방지)
   * - 미정산 + isSettleBalance=true → balance 복원
   * - 미정산 + isSettleBalance=false → allSettleAmount 차감 (여신 복구)
   *
   * 멱등성: order_delivery_refund UNIQUE 제약으로 중복 환불 차단.
   *
   * 순서 (plans/ssg-balance-refactor.md PR3 D):
   * 1) refundLedgerService.claim() 먼저 호출 — 중복 호출이면 BadRequestException 으로 즉시 차단
   * 2) claim 성공 시에만 SSG 행사 잔액 복구 + 사용자 잔액/정산 복구
   * 이렇게 해야 ledger가 한 번만 진입하는 게이트로 동작해 SSG 잔액 중복 복구를 막는다.
   * (이전 순서: SSG 먼저 → ledger 가 막더라도 SSG 잔액은 이미 복구됨 = 중복 위험.)
   */
  private async refundForFail(orderDelivery: OrderDeliveryEntity): Promise<void> {
    // 컷오버 전환 건 거부(§9 인벤토리 #5). 전환 건의 환불은 refund_attempt CLAIMED→SUBMITTING 뒤
    // 실행 단계로만 호출한다. 호출처 4곳 어디서 들어와도 여기서 한 번에 막힌다.
    await this.cutoverGuard.assertLegacyAllowed(orderDelivery.id, LegacyDeliveryEntryPoint.BATCH_REFUND_FOR_FAIL);

    const order = orderDelivery.orderProductMapping.order;
    const mapping = orderDelivery.orderProductMapping;
    const productPrice = mapping.product.price;
    const settlementPrice = calculateSettlementPrice(mapping, order.cardSurchargeApplied, orderDelivery);
    const userId = order.clientUserId ?? order.user!.id;
    const shouldRestoreBalance = order.isSettleComplete || order.isSettleBalance;

    const isSsg = order.type === IOrderType.SSG && !!orderDelivery.ssgEventId;
    const isWalletManaged = await this.walletManagedPredicate.isWalletManaged(order.id);

    // 1) ledger.claim — 멱등 게이트.
    //    - legacy path: 중복이면 이전 처리 성공이므로 short-circuit return.
    //    - wallet path: claim 만 commit 되고 wallet 차감 실패한 retry 케이스 가능 → wallet 재시도 진행.
    //      RefundPoolService.refund 가 idempotencyKeyPrefix 기반 동시 race 차단 + 기존 ledger return.
    //    plan §4 / qa D2-11: 내부 환불 실패는 반드시 throw 전파 (claim 중복 분기만 흡수).
    let claimWasDuplicate = false;
    try {
      await this.refundLedgerService.claim({
        orderDeliveryId: orderDelivery.id,
        userId,
        refundAmount: settlementPrice,
        restoreType: shouldRestoreBalance ? 'BALANCE' : 'ALL_SETTLE_AMOUNT',
        isSettleComplete: order.isSettleComplete,
        isSettleBalance: order.isSettleBalance,
        sourcePath: 'BATCH_FAIL',
        operatorUserId: null,
        memo: `발송 실패 환불 (주문번호: ${order.id})`,
        // SSG 주문이면 ledger 의 ssg_balance_settled 를 false 로 시작.
        // resolver 가 RESTORED/SKIPPED_CONFIRMED 반환 시 markSsgSettled 로 true 갱신.
        // DEFERRED 면 false 유지 → 다음 재발송 가드 차단 (이중 차감 방지).
        ssgPending: isSsg,
      });
    } catch (error) {
      if (error instanceof BadRequestException) {
        // claim 중복. wallet/legacy 모두 재시도 진행(early return 금지) — claim() 은 TX 밖 즉시 commit 이라
        // 앞선 시도가 claim commit 후 balance/wallet 복구 단계에서 실패했을 수 있다(claim 중복 != 복구 완료).
        // wallet 은 RefundPoolService 멱등, legacy 는 아래 step3 에서 wallet_transaction 멱등키 존재로 완료
        // 판정 후 미완료면 재환불. SSG 는 ssg_balance_settled 가드로 이중 복구 차단(ledger 는 삭제하지 않는다).
        claimWasDuplicate = true;
        this.logger.warn(
          `[REFUND] claim 중복 — ${isWalletManaged ? 'wallet' : 'legacy'} 멱등 재시도 진행. orderDelivery.id: ${orderDelivery.id}, message: ${error.message}`,
        );
      } else {
        throw error;
      }
    }

    // 2) SSG 행사 잔액 복구.
    //    claim 중복 (wallet retry) 케이스에서도 ledger.ssg_balance_settled=false 면 SSG 측이
    //    아직 보정되지 않은 상태이므로 resolver 재실행해야 한다 (DEFERRED / crash 회복 시나리오).
    //    true 면 이미 SSG 처리 완료 → skip (이중 복구 차단).
    if (isSsg) {
      const ssgAlreadySettled = claimWasDuplicate
        ? await this.refundLedgerService.isSsgSettled(orderDelivery.id)
        : false;
      if (!ssgAlreadySettled) {
        // claim 직후 이 cycle 의 ledger id 를 캡처해 명시 전달 — resolver→refundForDeliveryFail 의
        // 재조회(지연 시 cross-cycle 멱등키 오염, HIGH)를 방지한다.
        const refundLedgerId = await this.refundLedgerService.getLedgerId(orderDelivery.id);
        const outcome = await this.ssgRefundResolverService.resolveAndRefundIfNeeded({
          orderDeliveryId: orderDelivery.id,
          ssgEventId: orderDelivery.ssgEventId!,
          refundAmount: productPrice,
          orderId: order.id,
          refundLedgerId: refundLedgerId ?? undefined,
        });
        if (outcome === SsgRefundOutcome.DEFERRED) {
          this.logger.error(
            `[REFUND] SSG 잔액 보정 DEFERRED — ledger.ssg_balance_settled=false 유지. 운영 점검 필요. orderDelivery.id: ${orderDelivery.id}`,
          );
        }
      } else {
        this.logger.log(
          `[REFUND] SSG 보정 skip — ssg_balance_settled=true (이미 보정 완료). orderDelivery.id: ${orderDelivery.id}`,
        );
      }
    }

    // 3) wallet / legacy 잔액 복구. 실패는 throw 전파 → caller (processOneDeliveryForBatch outer catch) 에서
    //    claimedAt reset 후 다음 batch 재시도. wallet 은 attemptId prefix 로 멱등 → 안전 재실행.
    if (isWalletManaged) {
      // fail_refund cycle = 현재 발송 사이클의 active attempt PK (§2/§4). 최초 실패는 INITIAL,
      // 재발송 후 재실패는 직전 RESEND attempt 가 active 다. INITIAL 고정 시 재발송→재실패가
      // 이전 reversed ledger 와 같은 prefix 를 만들어 refund 가 silent no-op 된다 → 최신 attempt 사용.
      const activeAttempt = await this.orderDeliveryAttemptRepository.findOne({
        where: { orderDeliveryId: orderDelivery.id },
        order: { id: 'DESC' },
      });
      if (!activeAttempt) {
        // drift: wallet 분기 진입했는데 deliveryConfirmed/재발송 hook 이 attempt 를 남기지 않은 상황.
        throw new Error(`wallet-managed delivery ${orderDelivery.id} missing attempt — drift, aborting refund`);
      }
      await this.refundPoolService.refund({
        orderId: order.id,
        eventType: OrderPaymentRefundEventType.FAIL_REFUND,
        targetDeliveryIds: [orderDelivery.id],
        attemptId: activeAttempt.id,
        refundFromAttemptTransactions: activeAttempt.attemptType === OrderDeliveryAttemptType.RESEND,
        idempotencyKeyPrefix: `fail_refund:${order.id}:${orderDelivery.id}:${activeAttempt.id}`,
      });
      this.logger.log(
        `[REFUND] wallet path complete - orderDelivery.id: ${orderDelivery.id}, attemptId: ${activeAttempt.id}`,
      );
    } else {
      // legacy path. claim() 은 위(L278)에서 이미 commit 됐고, balance 복구는 별도 @Transactional 이라
      // 앞선 시도가 balance 복구 전에 실패했으면 claim 만 남는다. claim 중복(재시도) 시 ledger 를 삭제하지
      // 않고(삭제하면 SSG 잔액이 새 ledger PK 로 이중 복구됨) balance 복구 완료 여부를 wallet_transaction
      // 멱등키 존재로 판정: 완료면 skip(중복 balance 복구/addBalance 이중 방지), 미완료면 재환불(재실행 안전).
      const failLedgerId = await this.refundLedgerService.getLedgerId(orderDelivery.id);
      if (claimWasDuplicate) {
        const txRepo = this.orderRepository.manager.getRepository(WalletTransactionEntity);
        const alreadyRestored = shouldRestoreBalance
          ? (await txRepo.count({
              where: { idempotencyKey: `legacy_fail_refund:${order.id}:${orderDelivery.id}:${failLedgerId}:deposit` },
            })) > 0
          : (await txRepo.count({
              where: { idempotencyKey: Like(`legacy_fail_refund:${order.id}:${orderDelivery.id}:credit:%`) },
            })) > 0;
        if (alreadyRestored) {
          this.logger.warn(
            `[REFUND] legacy 환불 재시도 — 이미 balance 복구 완료(wallet_transaction 존재), 멱등 skip. orderDelivery.id: ${orderDelivery.id}`,
          );
          return;
        }
      }
      if (shouldRestoreBalance) {
        await this.applyLegacyFailRefundDeposit(
          userId,
          order.id,
          orderDelivery.id,
          settlementPrice,
          failLedgerId,
          `발송 실패 환불 (주문번호: ${order.id})`,
        );
      } else {
        await this.applyLegacyFailRefundCredit(userId, order.id, orderDelivery.id, settlementPrice);
      }
      this.logger.log(
        `[REFUND] legacy path complete - orderDelivery.id: ${orderDelivery.id}, amount: ${settlementPrice} (정가: ${productPrice})`,
      );
    }
  }

  /**
   * 레거시(allocation 없음) 발송실패 환불의 외상 차감 + wallet credit 동기화를 한 DB TX 로 묶는다.
   * refundForFail 본체는 @Transactional 이 아니므로(외부 SSG 호출 포함) 이 블록만 원자화한다.
   * @Transactional REQUIRED — 외부 TX 존재 시 흡수, 없으면 신규 TX. wallet 미존재 throw 시 all_settle 도 롤백.
   */
  @Transactional()
  private async applyLegacyFailRefundCredit(
    userId: number,
    orderId: number,
    orderDeliveryId: number,
    amount: number,
  ): Promise<void> {
    await this.userRepository
      .createQueryBuilder()
      .update()
      .set({ allSettleAmount: () => 'all_settle_amount - :amount' })
      .where('id = :id', { id: userId })
      .setParameters({ amount })
      .execute();
    await this.legacyWalletCreditSyncService.syncCredit(this.orderRepository.manager, {
      billingUserId: userId,
      orderId,
      orderDeliveryId,
      delta: -amount,
      type: 'FAIL_REFUND',
      memo: `발송 실패 환불 (주문번호: ${orderId})`,
    });
  }

  /**
   * 레거시(allocation 없음) 발송실패 환불의 예치금 복구 + wallet deposit 동기화를 한 DB TX 로 묶는다.
   * applyLegacyFailRefundCredit(여신) 과 동일 패턴 — addBalance(예치금 환불) + syncDeposit 를 원자화한다.
   * @Transactional REQUIRED — 외부 TX 존재 시 흡수, 없으면 신규 TX. wallet 미존재 throw 시 전체 롤백.
   */
  @Transactional()
  private async applyLegacyFailRefundDeposit(
    userId: number,
    orderId: number,
    orderDeliveryId: number,
    amount: number,
    ledgerId: number | null,
    memo: string,
  ): Promise<void> {
    await this.userManagementService.addBalance(userId, amount, memo);
    await this.legacyWalletCreditSyncService.syncDeposit(this.orderRepository.manager, {
      billingUserId: userId,
      orderId,
      orderDeliveryId,
      delta: amount,
      type: 'FAIL_REFUND',
      idempotencyKey: `legacy_fail_refund:${orderId}:${orderDeliveryId}:${ledgerId}:deposit`,
      memo,
    });
  }

  /**
   * 비정상 종료로 남은 WAIT 행의 claimedAt 을 해제한다. main.ts 에서 listen() 전 1회 호출.
   *
   * ★ 배치가 잡은 변형 lease 도 함께 해제한다 (리뷰 MEDIUM).
   *   claimWaitDeliveries 는 이제 claimedAt 과 mutationClaimedAt 을 **같은 토큰으로 함께** 세팅한다.
   *   claimedAt 만 지우면 mutation_claimed_at 이 남아, 재시작 후 최대 5분간
   *   **그 행의 폐기·외부취소·핀상태변경이 전부 "다른 처리가 진행 중" 으로 거절된다** —
   *   실제로는 아무것도 안 돌고 있는데. 하필 재시작 = 사고 대응 중인 시점에 사고 대응 액션이 막힌다.
   *
   *   `mutation_claimed_at = claimed_at` 조건이 **필수**다. 이게 "배치가 잡은 lease" 의 서명이다.
   *   조건 없이 지우면 멀티팟에서 **다른 팟이 진행 중인 재발행/폐기의 살아있는 lease** 를 부팅 팟이
   *   지워버린다(컬럼을 분리한 이유를 정면으로 부순다).
   *   WAIT + claimed_at IS NOT NULL ⟹ 배치 소유가 성립함을 전수 확인했다:
   *     - 재발행 tip 은 claimedAt=NULL (lease 만 보유)
   *     - runReportFallback 은 claimedAt 을 안 쓴다
   *     - reSend/발송실패내역 재발송은 status 가 WAIT 가 아니다
   */
  async releaseStaleBatchClaims(): Promise<number> {
    // ① 배치가 잡은 변형 lease 만 먼저 해제한다. claimed_at 을 아직 지우기 전이어야
    //    `mutation_claimed_at = claimed_at` 서명을 대조할 수 있다(순서 필수).
    //
    // ★ stale 술어가 **필수**다 (4차 조준 리뷰 HIGH x2 — 내가 만든 회귀).
    //   이 메서드는 부팅 시 1회 돌지만, 롤링 배포·다중 인스턴스에서는 **다른 팟이 지금 발송 중**일 수
    //   있다. 나이 조건 없이 지우면:
    //     팟 B: od#123 claim(claimed_at=mutation_claimed_at=T) → 협력사 issue() 진행 중(수 초)
    //     팟 A: 부팅 → ①이 B 의 **살아있는 lease** 를 벗김 → 그 즉시 폐기·외부취소·다른 팟 claim 에
    //           전부 열림 → B 가 발송하는 사이 폐기가 협력사 취소 + 환불 → 환불된 핀이 배달된다.
    //   종전에는 ②가 claimed_at 만 벗겨도 **변형 lease 가 남아 폐기를 막아주고 있었다.**
    //   내가 ①을 추가하면서 그 마지막 방벽을 걷어냈다.
    //   stale(5분 초과)만 지우면: 크래시 잔재는 회수되고(살아있는 발송은 초 단위라 절대 안 걸린다),
    //   살아있는 팟은 건드리지 않는다. 5분 미만의 잔재는 claimWaitDeliveries 의 per-row self-heal 이
    //   어차피 회수한다.
    const staleThreshold = new Date(Date.now() - MUTATION_CLAIM_STALE_MS);
    await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({ mutationClaimedAt: null })
      .where('status = :status', { status: IOrderDeliveryStatus.WAIT })
      .andWhere('claimedAt IS NOT NULL')
      .andWhere('claimed_at < :staleThreshold', { staleThreshold })
      .andWhere('mutation_claimed_at = claimed_at')
      .execute();

    // ② claimedAt 해제는 **조건 없이**. ①의 서명 조건을 여기 합치면, 구버전 코드가 claim 해
    //    mutation_claimed_at 이 NULL 인 행(배포 직전 크래시 잔재)이 영원히 안 풀린다.
    const result = await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({ claimedAt: null })
      .where('status = :status', { status: IOrderDeliveryStatus.WAIT })
      .andWhere('claimedAt IS NOT NULL')
      .execute();
    return result.affected ?? 0;
  }

  /**
   * WAIT 발송 대기 행을 claimedAt 으로 멱등 claim. 비동기 PENDING(report_state)·external(order.type=EXTERNAL) 제외.
   * external 은 자체 동기 dispatch 이므로 batch claim 에서 원자적으로 배제(중복 issue/발송·차감 전 발송 차단).
   * 변형 lease(mutation_claimed_at) 활성 행도 제외 — 재발행(폐기후신규발송) tip 은 WAIT 로 INSERT 되므로,
   * lease 없이는 배치가 집어가 재발행 자체 발송과 이중 발송이 된다. stale(5분 초과)은 크래시 잔재로 보고
   * 정상 수거한다(발급된 PIN 의 미발송 정체 방지 — 기존 WAIT self-heal 경로 유지).
   *
   * ★ stale 수거는 lease 를 WHERE 로 통과시키는 데 그치지 않고 SET 으로 **탈취**해야 한다.
   *   값을 그대로 두면 원 소유자(좀비)의 fencing 조건(mutation_claimed_at = :myClaimAt)이 여전히
   *   일치해 affected=1 로 성공한다 — fencing 이 설계된 바로 그 상황에서 발동하지 않는다.
   *   탈취하면 좀비의 쓰기가 affected=0 이 되어 "조용한 이중 발급" 이 "시끄러운 중단" 으로 바뀐다.
   * @returns claim 된 행 수
   */
  async claimWaitDeliveries(claimedAt: Date): Promise<number> {
    const mutationStale = new Date(claimedAt.getTime() - MUTATION_CLAIM_STALE_MS);
    const claimResult = await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      // 변형 lease 를 배치 소유로 탈취(위 주석). claimedAt 과 동일 값이라 소유자 식별도 일관된다.
      .set({ claimedAt, mutationClaimedAt: claimedAt })
      .where('status = :status', { status: IOrderDeliveryStatus.WAIT })
      .andWhere('sendRequestAt < :now', { now: claimedAt })
      .andWhere('claimedAt IS NULL')
      // 변형(재발행/폐기/취소) 진행중 행은 발송 배치가 건드리지 않는다 (D3-55 후속)
      .andWhere('(mutation_claimed_at IS NULL OR mutation_claimed_at < :mutationStale)', { mutationStale })
      // 이미 폐기/환불된 쿠폰은 발송하지 않는다. status 와 coupon_status 는 다른 축이라
      // 폐기(coupon_status=CANCEL)가 status 를 건드리지 않으므로, 어떤 이유로든 WAIT 로 남은
      // 취소 행을 배치가 집어 "환불된 죽은 핀"을 고객에게 발송할 수 있었다 (리뷰 HIGH).
      .andWhere('(coupon_status IS NULL OR coupon_status NOT IN (:...blockedCouponStatuses))', {
        blockedCouponStatuses: UNSENDABLE_COUPON_STATUSES,
      })
      // soft-delete 된 행은 집지 않는다. UpdateQueryBuilder 는 deleted_at 필터를 **자동 적용하지 않는다**
      // (SelectQueryBuilder 와 달리). 재발행 실패 시 unwindReissue 가 tip 을 softDelete 하는데,
      // 이 조건이 없으면 그 행이 status=WAIT / coupon_status=NOT_USED 로 남아 배치가 집어
      // PIN 을 발급·발송한다 — 이미 폐기 역전으로 원본이 살아난 뒤라면 고객 쿠폰이 2장이 된다.
      // SSG 는 선차감까지 역복원된 뒤라 미차감 발급이다 (리뷰 CONFIRMED).
      .andWhere('deleted_at IS NULL')
      // 비동기 알림톡 PENDING(report_state) 행은 발송 배치 재발송 대상 아님 (reportSweep 소관)
      .andWhere('report_state IS NULL')
      // external_api 발송 건은 자체 동기 dispatch — batch 가 절대 claim 하지 않음 (중복 issue/발송 차단)
      .andWhere(
        'EXISTS (SELECT 1 FROM order_product_mapping opm JOIN `order` o ON o.id = opm.order_id ' +
          'WHERE opm.id = order_delivery.order_product_mapping_id AND o.type != :externalType)',
        { externalType: IOrderType.EXTERNAL },
      )
      // 컷오버 드레이닝·전환 건은 배치가 집지 않는다. 가드 통과 후 지연된 워커까지 막으려면
      // 판정이 아니라 **점유와 같은 문장**이어야 한다(§9 quiesce, admission race).
      .andWhere(NOT_CUTOVER_ORDER_DELIVERY)
      .execute();
    return claimResult.affected ?? 0;
  }

  async issueAndSend() {
    // 다른 배치가 동시에 돌더라도 UPDATE는 DB에서 직렬화되므로
    // claimed_at IS NULL 조건에 걸린 행만 이 배치가 소유하게 된다.
    // claimedAt 값은 이번 배치의 식별자로도 사용해서 뒤의 SELECT가 우리 몫만 가져오도록 한다.
    const claimedAt = new Date();
    const claimedCount = await this.claimWaitDeliveries(claimedAt);
    this.logger.log(`[BATCH] Claimed ${claimedCount} deliveries at ${claimedAt.toISOString()}`);

    if (claimedCount === 0) {
      return;
    }

    const queryBuilder = this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'company')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .where('orderDelivery.status = :status', { status: IOrderDeliveryStatus.WAIT })
      .andWhere('orderDelivery.claimedAt = :claimedAt', { claimedAt })
      .andWhere('orderDelivery.reportState IS NULL')
      .andWhere('order.type != :externalType', { externalType: IOrderType.EXTERNAL });

    const orderDeliveryList = await queryBuilder.getMany();

    this.logger.log(`[BATCH] Found ${orderDeliveryList.length} deliveries to send at ${claimedAt.toISOString()}`);

    if (orderDeliveryList.length === 0) {
      return;
    }

    // 중복 제거
    const processedIds = new Set<number>();
    const uniqueDeliveryList = orderDeliveryList.filter((od) => {
      if (processedIds.has(od.id)) {
        this.logger.warn(`[BATCH] Skip duplicate orderDelivery.id: ${od.id}`);
        return false;
      }
      processedIds.add(od.id);
      return true;
    });

    // 병렬 처리 결과 수집용
    const allResults: { deliveryHistory: DeliverySendHistoryEntity; orderId: number }[] = [];
    const concurrency = this.concurrencyLimit;
    this.logger.log(
      `[BATCH] Processing ${uniqueDeliveryList.length} deliveries (worker pool, concurrency: ${concurrency})`,
    );

    // 워커풀: 슬롯이 빌 때마다 다음 건을 즉시 투입 (고정 청크 경계 head-of-line blocking 제거).
    // 동시 처리 수는 concurrency 상한 유지. 건별 격리(processOneDeliveryForBatch 내부 try/catch)·SSG mutex 불변.
    let cursor = 0;
    let processedCount = 0;
    const nextDelivery = (): OrderDeliveryEntity | undefined => uniqueDeliveryList[cursor++];
    const runWorker = async (): Promise<void> => {
      let od: OrderDeliveryEntity | undefined;
      while ((od = nextDelivery()) !== undefined) {
        const result = await this.processOneDeliveryForBatch(od);
        if (result !== null) {
          allResults.push(result);
        }
        processedCount++;
        this.logger.log(`[BATCH] Processed ${processedCount}/${uniqueDeliveryList.length}`);
      }
    };
    const workerCount = Math.min(concurrency, uniqueDeliveryList.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    // 결과 집계
    const deliveryHistoryList = allResults.map((r) => r.deliveryHistory);
    const orderIdList = [...new Set(allResults.map((r) => r.orderId))];

    // 히스토리 insert
    if (deliveryHistoryList.length > 0) {
      await this.deliverySendHistoryRepository.insert(deliveryHistoryList);
    }

    // 주문 완료/정산: 전건 터미널 주문만 DELIVERY_COMPLETE + 선정산(단일 헬퍼 markOrderTerminalAndSettle).
    // 비동기 알림톡 PENDING(status=WAIT) 건은 전건 터미널이 아니므로 보류 → reportSweep 가 확정 시 정산.
    for (const orderId of orderIdList) {
      try {
        await this.markOrderTerminalAndSettle(orderId);
      } catch (error) {
        this.logger.error(`[BATCH] markOrderTerminalAndSettle 실패 orderId=${orderId}: ${error}`);
      }
    }

    this.logger.log(`[BATCH] Completed. Total: ${uniqueDeliveryList.length}, Success: ${deliveryHistoryList.length}`);
  }

  /**
   * 선정산(PRE_PAYMENT) 고객사 주문의 settleStatus를 자동으로 SETTLE_COMPLETE로 설정
   * - 대행주문(clientUserId)인 경우 clientUser의 settleCondition 기준으로 판단
   * - isSettleBalance=true(선입금 차감 건)만 SETTLE_COMPLETE로 설정
   * - isSettleBalance=false(한도 사용/신용초과 건)는 UNSETTLE_NORMAL 유지 (관리자 수동 정산)
   */
  private async autoSettlePrePaymentOrders(orderIdList: number[]): Promise<void> {
    if (orderIdList.length === 0) return;

    const orders = await this.orderRepository.find({
      where: { id: In(orderIdList) },
      relations: ['user', 'clientUser'],
    });

    // 과금 대상 user의 settleCondition이 PRE_PAYMENT인 주문 필터링
    // 대행주문(clientUserId)인 경우 clientUser 기준으로 판단
    // isSettleBalance=false(신용초과 등 한도 사용 건)는 미정산 유지
    const prePaymentOrders = orders.filter((order) => {
      const billingUser = order.clientUser ?? order.user;
      return billingUser?.settleCondition === IUserSettleCondition.PRE_PAYMENT;
    });

    const settleCompleteIds = prePaymentOrders.filter((o) => o.isSettleBalance).map((o) => o.id);

    const unsettledCount = prePaymentOrders.length - settleCompleteIds.length;

    if (settleCompleteIds.length > 0) {
      await this.orderRepository.update(
        { id: In(settleCompleteIds) },
        { settleStatus: SettleUserOrderDetailEnum.SETTLE_COMPLETE },
      );
      this.logger.log(`[BATCH] Auto-settled ${settleCompleteIds.length} pre-payment orders (balance-paid)`);
    }

    if (unsettledCount > 0) {
      this.logger.log(
        `[BATCH] Skipped auto-settle for ${unsettledCount} pre-payment orders (credit-excess, kept UNSETTLE_NORMAL)`,
      );
    }
  }

  // ───────────── Phase 5: 주문 완료/정산 단일 헬퍼 (issueAndSend / reportSweep 공유) ─────────────

  /**
   * order 의 모든 orderDelivery 가 터미널(COMPLETE/COMPLETE_SMS/FAIL/FAIL_SMS)인지.
   * WAIT/TEMP/PENDING 또는 CANCEL 이 하나라도 있으면 false — 취소 포함 주문은 자동 완료/정산 대상 아님(CS 처리).
   */
  private async isOrderAllDeliveriesTerminal(orderId: number): Promise<boolean> {
    const nonTerminal = await this.orderDeliveryRepository
      .createQueryBuilder('od')
      .innerJoin('od.orderProductMapping', 'opm')
      .where('opm.orderId = :orderId', { orderId })
      .andWhere('od.status NOT IN (:...terminal)', {
        terminal: [
          IOrderDeliveryStatus.COMPLETE,
          IOrderDeliveryStatus.COMPLETE_SMS,
          IOrderDeliveryStatus.FAIL,
          IOrderDeliveryStatus.FAIL_SMS,
        ],
      })
      .getCount();
    return nonTerminal === 0;
  }

  /**
   * 주문 상태 전이 CAS. 정상 선행상태(DELIVERY_CONFIRMED)에서만 DELIVERY_COMPLETE 로 전이.
   * CANCEL/COMPLETE 은 자연 제외(취소 되돌림·이중 전이 방지). 전이 발생 시 true.
   */
  private async transitionOrderToComplete(orderId: number): Promise<boolean> {
    const res = await this.orderRepository
      .createQueryBuilder()
      .update(OrderEntity)
      .set({ status: IOrderStatus.DELIVERY_COMPLETE })
      .where('id = :orderId', { orderId })
      .andWhere('status = :confirmed', { confirmed: IOrderStatus.DELIVERY_CONFIRMED })
      .execute();
    return (res.affected ?? 0) > 0;
  }

  /**
   * 선정산 drift 복구. order.status=DELIVERY_COMPLETE 일 때만 정산(취소·미완 주문 정산 차단).
   * autoSettlePrePaymentOrders 가 PRE_PAYMENT+isSettleBalance 필터 + 멱등.
   */
  private async settleIfDrift(orderId: number): Promise<void> {
    const order = await this.orderRepository.findOne({ where: { id: orderId } });
    if (!order || order.status !== IOrderStatus.DELIVERY_COMPLETE) {
      return;
    }
    await this.autoSettlePrePaymentOrders([orderId]);
  }

  /**
   * 주문 터미널 확정 + 정산. 전건 터미널(취소 미포함)일 때만 전이하고, 정산은 독립 멱등으로 시도(drift 복구).
   */
  private async markOrderTerminalAndSettle(orderId: number): Promise<void> {
    if (!(await this.isOrderAllDeliveriesTerminal(orderId))) {
      return;
    }
    await this.transitionOrderToComplete(orderId);
    try {
      await this.settleIfDrift(orderId);
    } catch (error) {
      // 실패해도 reconcileSettlementDrift 가 다음 sweep 에서 재시도(DELIVERY_COMPLETE+미정산 수렴).
      this.logger.error(`[SETTLE] settleIfDrift 실패 orderId=${orderId} (reconcile 재시도 예정): ${error}`);
    }
  }

  /**
   * 완료/정산 drift 복구 (sweep 마다 수렴 → 영구 미완료·미정산 방지, HIGH: reconciliation).
   * 1) completion drift: order=DELIVERY_CONFIRMED 이고 delivery 가 전건 터미널(COMPLETE/
   *    COMPLETE_SMS/FAIL/FAIL_SMS, CANCEL 없음)인데 order 가 미완료로 남은 건 → 완료 전이 + 정산.
   *    정산조건/reportState 와 무관(동기 SMS·EMAIL=reportState NULL, POST_PAYMENT 포함).
   * 2) settlement drift: DELIVERY_COMPLETE 인데 미정산(SETTLE_COMPLETE 아님) PRE_PAYMENT 건 → 재정산.
   *    PRE_PAYMENT 직접 제한으로 POST_PAYMENT 미정산 건이 LIMIT 슬롯을 반복 점유하는 starvation 차단.
   */
  private async reconcileSettlementDrift(): Promise<void> {
    // 1) completion drift: status=DELIVERY_CONFIRMED 이고 delivery 가 전건 터미널인 주문(정산조건/reportState 무관)
    const completionDrift = await this.orderDeliveryRepository
      .createQueryBuilder('od')
      .innerJoin('od.orderProductMapping', 'opm')
      .innerJoin('opm.order', 'o')
      .select('o.id', 'id')
      .where('o.status = :confirmed', { confirmed: IOrderStatus.DELIVERY_CONFIRMED })
      .groupBy('o.id')
      // 비터미널(WAIT/TEMP/PENDING/CANCEL 등) delivery 가 하나도 없을 때만 = 전건 터미널 & CANCEL 없음
      .having('SUM(CASE WHEN od.status NOT IN (:...terminal) THEN 1 ELSE 0 END) = 0', {
        terminal: [
          IOrderDeliveryStatus.COMPLETE,
          IOrderDeliveryStatus.COMPLETE_SMS,
          IOrderDeliveryStatus.FAIL,
          IOrderDeliveryStatus.FAIL_SMS,
        ],
      })
      .limit(REPORT_SWEEP_BATCH_LIMIT)
      .getRawMany<{ id: number }>();
    for (const { id } of completionDrift) {
      try {
        if (await this.isOrderAllDeliveriesTerminal(id)) {
          await this.transitionOrderToComplete(id);
          await this.settleIfDrift(id);
        }
      } catch (error) {
        this.logger.error(`[REPORT_SWEEP] completion drift 복구 실패 orderId=${id}: ${error}`);
      }
    }

    // 2) settlement drift: 완료됐으나 미정산인 PRE_PAYMENT 주문 재정산
    const rows = await this.orderRepository
      .createQueryBuilder('o')
      .leftJoin('o.user', 'u')
      .leftJoin('o.clientUser', 'cu')
      .select('o.id', 'id')
      .where('o.status = :complete', { complete: IOrderStatus.DELIVERY_COMPLETE })
      .andWhere('o.isSettleBalance = :t', { t: true })
      .andWhere('(o.settleStatus IS NULL OR o.settleStatus != :done)', {
        done: SettleUserOrderDetailEnum.SETTLE_COMPLETE,
      })
      .andWhere('COALESCE(cu.settle_condition, u.settle_condition) = :pre', {
        pre: IUserSettleCondition.PRE_PAYMENT,
      })
      .limit(REPORT_SWEEP_BATCH_LIMIT)
      .getRawMany<{ id: number }>();
    if (rows.length > 0) {
      await this.autoSettlePrePaymentOrders(rows.map((r) => r.id));
    }
  }

  // ───────────── Phase 4: 알림톡 비동기 수신확인(reportSweep) + 자동 재발송 1회 ─────────────

  /**
   * 발송 트랜잭션 밖에서 알림톡 수신리포트를 확인한다(30초×2 근사).
   * - 도착확정(10000) → COMPLETE + 정산
   * - 미확정(시도 소진/마감) → SMS 1회(at-most-once) → COMPLETE_SMS / FAIL+환불
   * - sweep 크래시로 stuck(fallback 선점됐으나 비터미널 + lease 초과) → 재전송 없이 FAIL 확정(CS 수동 회수)
   * 멱등 claim(report_claimed_at + report_owner_token)으로 다중 tick/PM2 다중 인스턴스 중복 차단.
   * 모든 종결/재시도 update 는 report_owner_token CAS 로 펜싱(lease 회전 후 stale worker 의 덮어쓰기 방지).
   */
  async reportSweep(): Promise<void> {
    const now = new Date();
    const leaseThreshold = new Date(now.getTime() - REPORT_CLAIM_LEASE_MS);

    // 1) 후보 선별(LIMIT): status=WAIT + PENDING + (정상 due 또는 stuck), 미claim 또는 lease 만료
    const candidates = await this.orderDeliveryRepository
      .createQueryBuilder('od')
      .select('od.id', 'id')
      .where('od.status = :wait', { wait: IOrderDeliveryStatus.WAIT })
      .andWhere('od.reportState = :pending', { pending: IOrderDeliveryReportState.PENDING })
      .andWhere('(od.reportNextDueAt <= :now OR od.reportFallbackAttemptCount >= 1)', { now })
      .andWhere('(od.reportClaimedAt IS NULL OR od.reportClaimedAt < :lease)', { lease: leaseThreshold })
      .orderBy('od.reportNextDueAt', 'ASC')
      .limit(REPORT_SWEEP_BATCH_LIMIT)
      .getRawMany<{ id: number }>();

    if (candidates.length > 0) {
      const candidateIds = candidates.map((c) => c.id);
      const token = randomUUID();

      // 2) 원자 claim(토큰 회전) — status/lease 재확인으로 동시 sweep 충돌 차단
      await this.orderDeliveryRepository
        .createQueryBuilder()
        .update(OrderDeliveryEntity)
        .set({ reportClaimedAt: now, reportOwnerToken: token })
        .where('id IN (:...ids)', { ids: candidateIds })
        .andWhere('status = :wait', { wait: IOrderDeliveryStatus.WAIT })
        .andWhere('report_state = :pending', { pending: IOrderDeliveryReportState.PENDING })
        .andWhere('(report_claimed_at IS NULL OR report_claimed_at < :lease)', { lease: leaseThreshold })
        .execute();

      // 3) 자기 토큰 행만 처리
      const rows = await this.orderDeliveryRepository
        .createQueryBuilder('orderDelivery')
        .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
        .innerJoinAndSelect('orderProductMapping.order', 'order')
        .leftJoinAndSelect('order.user', 'user')
        .leftJoinAndSelect('order.clientUser', 'clientUser')
        .leftJoinAndSelect('orderProductMapping.product', 'product')
        .leftJoinAndSelect('product.brand', 'brand')
        .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
        .leftJoinAndSelect('orderDelivery.ssgEvent', 'ssgEvent')
        .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
        .leftJoinAndSelect('choiceSelectProduct.brand', 'choiceBrand')
        .where('orderDelivery.reportOwnerToken = :token', { token })
        .andWhere('orderDelivery.reportState = :pending', { pending: IOrderDeliveryReportState.PENDING })
        .getMany();

      this.logger.log(`[REPORT_SWEEP] claimed ${rows.length} pending alimtalk reports (token=${token})`);

      for (const od of rows) {
        try {
          await this.processOneReport(od, token);
        } catch (error) {
          this.logger.error(`[REPORT_SWEEP] orderDelivery.id=${od.id} 처리 실패: ${error}`);
        }
      }
    }

    // 정산 drift 복구: DELIVERY_COMPLETE 인데 미정산 PRE_PAYMENT 주문 재정산 (settleIfDrift 실패분 수렴)
    try {
      await this.reconcileSettlementDrift();
    } catch (error) {
      this.logger.error(`[REPORT_SWEEP] reconcileSettlementDrift 실패: ${error}`);
    }
  }

  /**
   * 단건 리포트 처리: 도착확정 / 재시도 / 미확정 종결(R1) 분기. token CAS 로 소유권 펜싱.
   */
  private async processOneReport(od: OrderDeliveryEntity, token: string): Promise<void> {
    od.reportAttemptCount = (od.reportAttemptCount ?? 0) + 1;

    const inquiry = od.alimTalkMsgKey
      ? await this.deliveryAlimTalk.inquiryReport(od.alimTalkMsgKey)
      : { success: false, error: 'msgKey 없음(POST 실패)' };

    if (inquiry.success && inquiry.reportCode === '10000') {
      od.reportState = IOrderDeliveryReportState.CONFIRMED;
      this.releaseReportClaim(od);
      this.markSendSuccess(od, IOrderDeliveryStatus.COMPLETE);
      // 소유권 보유 시에만 종결/정산 (lease 회전 시 stale write·이중 정산 방지)
      if (await this.persistReportState(od, token)) {
        // 알림톡 시도도 같은 확정으로 닫는다. 여기서 닫지 않으면 MSEQ 없는 알림톡 attempt 를
        // 볼 주체가 없어(reconcileOnce 는 mseq 보유 건만 훑는다) SLA 초과로 UNKNOWN 이 된다.
        await this.messageResultReconcileService.settleAlimTalkReport(od.id, true);
        await this.correctSendHistory(od.id, true, inquiry.data ?? { reportCode: '10000' });
        await this.markOrderTerminalAndSettle(od.orderProductMapping.order.id);
      }
      return;
    }

    const now = new Date();
    const attemptExhausted = od.reportAttemptCount >= REPORT_MAX_INQUIRY_ATTEMPTS;
    const deadlineExceeded = od.reportDeadlineAt != null && now >= od.reportDeadlineAt;

    if (!attemptExhausted && !deadlineExceeded) {
      // 다음 tick 재시도: claim 해제 + next_due 갱신 (token CAS — 소유권 상실 시 no-op)
      this.releaseReportClaim(od);
      od.reportNextDueAt = new Date(now.getTime() + REPORT_NEXT_DUE_MS);
      await this.persistReportState(od, token);
      return;
    }

    // 여기부터는 R1(재시도 소진·기한 초과) 구간이라 알림톡은 더 이상 확정 성공할 수 없다.
    // 폴백 SMS 는 이 확정 실패를 부모로 삼는 CHANNEL_FALLBACK 시도다(§5.3).
    await this.messageResultReconcileService.settleAlimTalkReport(od.id, false);

    // 심야 자동 발송 금지(08:00–20:00 KST 밖) — SMS 폴백도 **배치가 트리거하는 발송**이라
    // 광고성 정보 전송 제한 대상이다. 폴백을 포기하지 않고 다음 허용 시작으로 미룬다.
    // (재시도 소진·기한 초과로 여기까지 온 건이므로 다음 창에서 즉시 폴백된다.)
    if (!isWithinAllowedSendWindow(now)) {
      const deferUntil = computeNextAttemptAt(now);
      this.releaseReportClaim(od);
      od.reportNextDueAt = deferUntil;
      await this.persistReportState(od, token);
      this.logger.log(`[REPORT_SWEEP][R1] 심야 SMS 폴백 보류 — od=${od.id}, 재개 예정=${deferUntil.toISOString()}`);
      return;
    }

    await this.runReportFallback(od, token);
  }

  /**
   * 자동 재발송 1회(R1): SMS 대체 발송. at-most-once 선점(fallback_count 0→1 + 소유 token CAS) 후 affected=1 일 때만 전송.
   * sendSms 코어(csResendAsMms) 직접 사용 — oneSend/reverseRefundForResend 경로 미사용(환불→재차감 루프 차단).
   */
  private async runReportFallback(od: OrderDeliveryEntity, token: string): Promise<void> {
    // ★ SMS 대체발송도 "발송" 이다 — 변형 lease + 쿠폰상태 가드가 필요하다 (D3-55 후속, 리뷰).
    //
    //   report_owner_token 은 리포트 sweep 워커끼리의 소유권일 뿐, 폐기/외부취소/재발행과는
    //   아무 관계가 없다. 알림톡 POST 는 성공했지만 수신확인이 안 된 채 재시도를 소진하는
    //   동안(분 단위) 그 쿠폰이 폐기·환불될 수 있고, 종전 코드는 그 죽은 핀을 SMS 로 다시
    //   보낸 뒤 markOrderTerminalAndSettle 로 **정산까지** 했다.
    //
    //   ★ 게이트 실패(affected=0)의 원인은 **4가지**이고, 처리가 서로 다르다 (리뷰 HIGH).
    //     WHERE 는 id/token/status=WAIT/lease/coupon_status 의 AND 라 affected=0 만으로는
    //     무엇이 틀렸는지 알 수 없다. 하나로 뭉개면 **일시적 원인까지 영구 봉인**된다 —
    //     status=WAIT + report_state=UNCONFIRMED 는 reportSweep(PENDING 요구)도,
    //     claimWaitDeliveries(report_state IS NULL 요구)도, CS reSend(COMPLETE/FAIL 요구)도,
    //     발송실패내역 재발송(FAIL/FAIL_SMS 요구)도 **아무도 집지 못하는 상태**다.
    //     그래서 fresh 로 1회 재조회해 원인별로 가른다.
    const mutationClaimAt = new Date();
    const mutationStale = new Date(mutationClaimAt.getTime() - MUTATION_CLAIM_STALE_MS);
    const leaseGate = await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({ mutationClaimedAt: mutationClaimAt })
      .where('id = :id', { id: od.id })
      .andWhere('report_owner_token = :token', { token })
      .andWhere('status = :wait', { wait: IOrderDeliveryStatus.WAIT })
      .andWhere('(mutation_claimed_at IS NULL OR mutation_claimed_at < :mutationStale)', { mutationStale })
      .andWhere('(coupon_status IS NULL OR coupon_status NOT IN (:...blockedCouponStatuses))', {
        blockedCouponStatuses: UNSENDABLE_COUPON_STATUSES,
      })
      // 컷오버 드레이닝·전환 건은 legacy 변형 lease 를 잡지 못한다(§9 quiesce).
      .andWhere(NOT_CUTOVER_ORDER_DELIVERY)
      .execute();

    if ((leaseGate.affected ?? 0) === 0) {
      const fresh = await this.orderDeliveryRepository.findOne({
        where: { id: od.id },
        select: ['id', 'status', 'couponStatus', 'mutationClaimedAt', 'reportOwnerToken'],
      });

      // (1) 폐기·환불 확정 — **유일하게 정당한 봉인**.
      //     recoverStuckFallback(→ FAIL 확정 + 환불)으로 보내면 폐기가 이미 끝낸 환불과 겹쳐
      //     이중 환불이 된다. 발송하지 않고 닫는다.
      if (fresh?.couponStatus && UNSENDABLE_COUPON_STATUSES.includes(fresh.couponStatus)) {
        this.logger.error(
          `[REPORT_SWEEP][R1] SMS 폴백 중단 — 폐기·환불된 쿠폰(coupon_status=${fresh.couponStatus}). od=${od.id}`,
        );
        od.reportState = IOrderDeliveryReportState.UNCONFIRMED;
        // ★ status 는 **건드리지 않는다** (4차 조준 리뷰 CRITICAL x2 — 앞선 라운드의 내 수정을 철회).
        //
        //   한때 여기서 status=CANCEL 로 "터미널 전이" 를 했다. 두 가지 이유로 틀렸다:
        //
        //   ① 정산을 열어주지 못한다. isOrderAllDeliveriesTerminal(L696)의 터미널 집합은
        //      [COMPLETE, COMPLETE_SMS, FAIL, FAIL_SMS] 로 **CANCEL 을 포함하지 않는다**.
        //      CANCEL 은 WAIT 과 똑같이 비터미널이라 주문은 그대로 미정산이다. 즉 얻는 게 없다.
        //      (주문 미정산 자체는 이 분기가 만든 문제가 아니다 — 폐기된 알림톡 PENDING 건은
        //       종전에도 status=WAIT 로 남아 똑같이 비터미널이었다. 별도 티켓.)
        //
        //   ② **lease 를 못 잡은 상태에서 남의 행에 터미널을 쓰는 짓이다.** 이 분기의 진입 조건
        //      자체가 leaseGate.affected=0 = "다른 액터가 이 행의 운명을 결정 중" 이다.
        //      그 액터가 재발행이면: execDiscard 가 원본을 CANCEL 로 만든 창에 우리가 status=CANCEL
        //      을 쓰고, 이후 재발행이 실패해 reverseDiscard 가 coupon_status 만 NOT_USED 로 되돌린다
        //      (reverseDiscard 는 status 를 안 만진다) → **status=CANCEL + coupon_status=NOT_USED**.
        //      고객은 알림톡으로 살아있는 쿠폰을 이미 받았는데 DB·CS 화면은 "취소됨" 이다.
        //      이 프로젝트가 내내 지켜온 규칙("변형은 lease 를 잡고 한다")을 정면으로 어긴다.
        //
        //   남는 행(status=WAIT + coupon_status=CANCEL + report_state=UNCONFIRMED)은 **무해하다**:
        //   쿠폰은 이미 죽고 환불도 끝났으므로 아무도 이 행에 할 일이 없고, 모든 발송 경로가
        //   coupon_status 가드로 이 행을 배제한다. 방치가 정답이다.
        this.releaseReportClaim(od);
        if (!(await this.persistReportState(od, token))) {
          this.logger.error(`[REPORT_SWEEP][R1] UNCONFIRMED 기록도 실패(소유권 상실) — od=${od.id}`);
        }
        return;
      }

      // (2) 이미 터미널(status != WAIT) — 종전 동작 유지. 성공 종결이면 claim 만 정리한다.
      if (fresh && fresh.status !== IOrderDeliveryStatus.WAIT) {
        await this.recoverStuckFallback(od, token);
        return;
      }

      // (3) 일시적 — 변형 lease 활성(폐기/재발행/CS 재발송 진행중) 또는 report 토큰 회전.
      //     "지금은 못 한다" 를 "영원히 안 한다" 로 만들면 안 된다. PENDING 을 유지한 채
      //     다음 due 로 미뤄 다음 tick 이 재시도하게 둔다(at-most-once 선점은 아직 안 했으므로 안전).
      //
      //     ★ 두 원인을 구분해 로깅한다 (리뷰 MEDIUM). 완전히 다른 사건이다:
      //       - lease 활성      = 정상. 곧 해소되거나 5분 stale 로 강탈된다.
      //       - 토큰 회전       = 동시 sweep 워커 2개 = **설정/배포 이상 신호**.
      //       - lease 나이가 stale 임계를 넘었는데도 계속 여기로 오면 = **lease 누수**(해제 실패).
      //     뭉뚱그리면 6개월 뒤 이 WARN 을 보는 사람이 어느 쪽인지 알 수 없다.
      const leaseAgeMs = fresh?.mutationClaimedAt ? Date.now() - fresh.mutationClaimedAt.getTime() : null;
      const tokenRotated = !!fresh && fresh.reportOwnerToken !== token;
      if (leaseAgeMs !== null && leaseAgeMs > MUTATION_CLAIM_STALE_MS) {
        // stale 인데도 게이트가 실패했다 = 다른 술어 때문이거나 lease 가 누수 중이다.
        this.logger.error(
          `[REPORT_SWEEP][R1] SMS 폴백 연기 — lease 가 stale(${Math.round(leaseAgeMs / 1000)}s) 인데도 ` +
            `게이트 실패. lease 누수 의심. od=${od.id}, tokenRotated=${tokenRotated}`,
        );
      } else {
        this.logger.warn(
          `[REPORT_SWEEP][R1] SMS 폴백 연기 — ${tokenRotated ? 'report 토큰 회전(동시 워커 의심)' : `변형 lease 활성(${leaseAgeMs === null ? 'n/a' : Math.round(leaseAgeMs / 1000) + 's'})`}. ` +
            `다음 tick 재시도. od=${od.id}`,
        );
      }
      this.releaseReportClaim(od);
      od.reportNextDueAt = new Date(Date.now() + REPORT_NEXT_DUE_MS);
      await this.persistReportState(od, token); // report_state 는 PENDING 유지
      return;
    }

    try {
      const preempt = await this.orderDeliveryRepository
        .createQueryBuilder()
        .update(OrderDeliveryEntity)
        .set({ reportFallbackAttemptCount: 1 })
        .where('id = :id', { id: od.id })
        .andWhere('report_fallback_attempt_count = 0')
        .andWhere('report_owner_token = :token', { token })
        // SMS(외부호출) 직전 fencing 완결: 이미 터미널로 전이됐거나 리포트 상태가 이탈한 행은 선점 자체를 차단
        .andWhere('status = :wait', { wait: IOrderDeliveryStatus.WAIT })
        .andWhere('report_state = :pending', { pending: IOrderDeliveryReportState.PENDING })
        .execute();

      if ((preempt.affected ?? 0) === 0) {
        // 이미 선점됨/소유권 상실 → recovery (재전송 안 함)
        await this.recoverStuckFallback(od, token);
        return;
      }
      od.reportFallbackAttemptCount = 1;

      let smsOk = false;
      try {
        await this.csResendAsMms(od.id);
        smsOk = true;
      } catch (error) {
        this.logger.error(`[REPORT_SWEEP][R1] SMS 폴백 실패 od=${od.id}: ${error}`);
      }

      od.reportState = IOrderDeliveryReportState.UNCONFIRMED;
      this.releaseReportClaim(od);

      if (smsOk) {
        this.markSendSuccess(od, IOrderDeliveryStatus.COMPLETE_SMS);
        // 소유권 보유 시에만 종결/정산 (lease 회전 시 stale worker 의 이력 정정·이중 정산 방지)
        if (await this.persistReportState(od, token)) {
          await this.correctSendHistory(od.id, true, { fallback: 'COMPLETE_SMS' });
          await this.markOrderTerminalAndSettle(od.orderProductMapping.order.id);
        }
      } else {
        await this.finalizeReportFail(od, token);
      }
    } finally {
      // 변형 lease 해제 — 자기 토큰으로만. 실패는 삼킨다(5분 stale self-heal).
      try {
        await this.orderDeliveryRepository.update(
          { id: od.id, mutationClaimedAt: mutationClaimAt },
          { mutationClaimedAt: null },
        );
      } catch (releaseError) {
        this.logger.error(`[REPORT_SWEEP][R1] 변형 lease 해제 실패 od=${od.id}, error: ${releaseError}`);
      }
    }
  }

  /**
   * fallback 선점됐으나 sweep 크래시로 비터미널 잔존 + lease 초과 → at-most-once 라 재전송 안 함.
   * 이미 성공 종결된 경우는 claim 만 정리, 아니면 결정적 FAIL 확정(CS 수동 reSend 로 회수).
   */
  private async recoverStuckFallback(od: OrderDeliveryEntity, token: string): Promise<void> {
    if (od.status === IOrderDeliveryStatus.COMPLETE_SMS || od.status === IOrderDeliveryStatus.COMPLETE) {
      od.reportState = IOrderDeliveryReportState.CONFIRMED;
      this.releaseReportClaim(od);
      // 이미 터미널(WAIT 아님) 행이므로 status=WAIT CAS 의 persistReportState 대신 claim 정리 전용 CAS 사용
      await this.clearReportClaim(od, token);
      return;
    }
    od.reportState = IOrderDeliveryReportState.UNCONFIRMED;
    this.releaseReportClaim(od);
    await this.finalizeReportFail(od, token);
  }

  /**
   * FAIL 확정 + 환불(B1/B3) + 정산. token CAS 로 소유권 보유 시에만 환불/정산(이중 환불 방지).
   */
  private async finalizeReportFail(od: OrderDeliveryEntity, token: string): Promise<void> {
    this.markSendFail(od, IOrderDeliveryStatus.FAIL);
    if (!(await this.persistReportState(od, token))) {
      // 소유권 상실 — 다른 owner 가 처리 중. 환불/정산 중복 방지 위해 중단.
      return;
    }
    await this.correctSendHistory(od.id, false, { fallback: 'FAIL' });

    const order = od.orderProductMapping.order;
    const shouldHold = await this.shouldHoldRefundForFail(od, order);
    if (!shouldHold) {
      await this.refundForFail(od);
    }
    await this.markOrderTerminalAndSettle(order.id);
  }

  /**
   * 비동기 POST 성공 이력(delivery_send_history)을 최종 결과(성공/실패)로 정정한다.
   */
  private async correctSendHistory(orderDeliveryId: number, isSuccess: boolean, outcome: unknown): Promise<void> {
    await this.deliverySendHistoryRepository
      .createQueryBuilder()
      .update(DeliverySendHistoryEntity)
      .set({ isSuccess, etcContext: JSON.stringify(outcome) })
      .where('order_delivery_id = :id', { id: orderDeliveryId })
      .execute();
  }

  /** reportSweep claim 해제: 점유 토큰/시각을 비운다(다음 tick 재claim 허용). */
  private releaseReportClaim(od: OrderDeliveryEntity): void {
    od.reportClaimedAt = null;
    od.reportOwnerToken = null;
  }

  /**
   * reportSweep 의 WAIT→터미널 전이/재시도 시 변경 컬럼만 타깃 update.
   * report_owner_token + status=WAIT + report_state=PENDING 3중 CAS 로 펜싱:
   *  - token: lease 회전 후 stale worker 의 덮어쓰기 차단
   *  - status=WAIT: 이미 터미널로 전이된 행의 재전이 차단(전이는 항상 WAIT 출발)
   *  - report_state=PENDING: 터미널 전이(CONFIRMED/UNCONFIRMED) 이후 stale 재기록 차단
   * (이미 터미널 상태인 행의 claim 정리는 status=WAIT 불충족이므로 clearReportClaim 사용)
   * @returns 소유권 보유(affected>0) 여부 — false 면 lease 회전/상태 이탈로 소유권 상실(write drop).
   */
  private async persistReportState(od: OrderDeliveryEntity, token: string): Promise<boolean> {
    const res = await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({
        status: od.status,
        actualSendAt: od.actualSendAt,
        failedAt: od.failedAt,
        reportState: od.reportState,
        reportAttemptCount: od.reportAttemptCount,
        reportFallbackAttemptCount: od.reportFallbackAttemptCount,
        reportNextDueAt: od.reportNextDueAt,
        reportClaimedAt: od.reportClaimedAt,
        reportOwnerToken: od.reportOwnerToken,
      })
      .where('id = :id', { id: od.id })
      .andWhere('report_owner_token = :token', { token })
      .andWhere('status = :wait', { wait: IOrderDeliveryStatus.WAIT })
      .andWhere('report_state = :pending', { pending: IOrderDeliveryReportState.PENDING })
      .execute();
    return (res.affected ?? 0) > 0;
  }

  /**
   * 이미 터미널 상태(WAIT 아님)인 행의 claim/리포트 상태만 정리한다(recoverStuckFallback 전용).
   * persistReportState 의 status=WAIT CAS 를 우회 — token + report_state=PENDING 으로만 펜싱.
   */
  private async clearReportClaim(od: OrderDeliveryEntity, token: string): Promise<boolean> {
    const res = await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({
        reportState: od.reportState,
        reportClaimedAt: od.reportClaimedAt,
        reportOwnerToken: od.reportOwnerToken,
      })
      .where('id = :id', { id: od.id })
      .andWhere('report_owner_token = :token', { token })
      .andWhere('report_state = :pending', { pending: IOrderDeliveryReportState.PENDING })
      .execute();
    return (res.affected ?? 0) > 0;
  }

  /**
   * 단일 배송건 처리 (배치용) - PIN 발급 + 발송 + DB 저장
   *
   * 예외 발생 시 status=WAIT 행의 claimedAt을 해제해 다음 cron에서 재시도되게 한다.
   * 해제 안 하면 row가 영구 stale claim 상태로 빠져 부팅 시 releaseStaleClaims만이
   * 풀 수 있는 사고가 된다. status가 이미 FAIL/COMPLETE면 건드리지 않음.
   * claimedAt reset 은 owner guard(claimedAt = 내 토큰) 로 남의 claim 을 풀지 않는다.
   *
   * 변형 lease(claimWaitDeliveries 가 탈취한 mutation_claimed_at)는 성공/실패 모두 finally 에서
   * owner-guarded 해제한다. 해제하지 않으면 발송 직후 stale(5분) 까지 폐기·취소가 전부 거절된다.
   */
  private async processOneDeliveryForBatch(
    orderDelivery: OrderDeliveryEntity,
  ): Promise<{ deliveryHistory: DeliverySendHistoryEntity; orderId: number } | null> {
    const claimToken = orderDelivery.claimedAt;
    try {
      const result = await this.processOneDeliveryInternal(orderDelivery, claimToken);
      return result;
    } catch (error) {
      this.logger.error(`[BATCH] Failed to process orderDelivery.id: ${orderDelivery.id}, error: ${error}`);
      try {
        await this.orderDeliveryRepository.update(
          { id: orderDelivery.id, status: IOrderDeliveryStatus.WAIT, claimedAt: claimToken ?? undefined },
          { claimedAt: null },
        );
      } catch (resetError) {
        this.logger.error(`[BATCH] claimedAt reset 실패 - orderDelivery.id: ${orderDelivery.id}, error: ${resetError}`);
      }
      return null;
    } finally {
      if (claimToken) {
        try {
          await this.orderDeliveryRepository.update(
            { id: orderDelivery.id, mutationClaimedAt: claimToken },
            { mutationClaimedAt: null },
          );
        } catch (releaseError) {
          this.logger.error(
            `[BATCH] 변형 lease 해제 실패 - orderDelivery.id: ${orderDelivery.id}, error: ${releaseError}`,
          );
        }
      }
    }
  }

  /**
   * 배치가 자기 소유를 유지하는 동안에만 쓰는 targeted update (리뷰 HIGH).
   *
   * PIN 발급·문자 발송은 외부 통신이라 수 초~수십 초가 걸리고 변형 lease 는 5분 stale
   * self-heal 이다. 그 사이 폐기·외부취소·재발행이 lease 를 가져가 상태를 확정할 수 있는데,
   * 조건이 `{ id }` 뿐이면 배치가 **남이 확정한 상태 위에 자기 결과를 덮어쓴다**.
   * (컬럼 범위를 좁힌 D3-60 수정은 "무엇을 쓰나"만 고쳤고 "쓸 자격이 있나"는 그대로였다.)
   *
   * affected=0 이면 **예외를 던지지 않고 건너뛴다**: 이 시점엔 이미 문자가 나갔을 수 있어
   * 예외 → 재시도가 중복 발송이 된다. 대신 [BATCH_FENCE_LOST] 로 반드시 경보한다.
   *
   * claimToken 이 없으면(테스트·레거시 경로) 종전대로 무울타리로 쓴다.
   *
   * @returns 실제로 썼으면 true, lease 상실로 건너뛰었으면 false
   */
  private async updateDeliveryOwned(
    orderDeliveryId: number,
    claimToken: Date | null | undefined,
    patch: Parameters<Repository<OrderDeliveryEntity>['update']>[1],
    label: string,
    /** 경보 로그에 함께 남길 주문 id. 운영이 잃은 쓰기를 대사할 때 order 조인을 손으로 안 하도록. */
    orderId?: number,
  ): Promise<boolean> {
    const where = claimToken ? { id: orderDeliveryId, mutationClaimedAt: claimToken } : { id: orderDeliveryId };

    const res = await this.orderDeliveryRepository.update(where, patch);

    // affected=0 판정은 MySQL 기본(CLIENT_FOUND_ROWS 미설정)의 "값이 실제로 바뀐 행 수" 세만틱에
    // 기댄다. 이 배치의 patch 는 모든 실경로에서 status 를 전이(WAIT→COMPLETE/FAIL)하므로
    // 정상 경로에서는 affected≥1 이 보장돼 오탐이 없다. 만약 값 무변경 재진입 쓰기가 생기면
    // 여기서 거짓 [BATCH_FENCE_LOST] 가 뜰 수 있음을 유의(무해 — 로그만, 쓰기 자체는 멱등).
    if (claimToken && !res.affected) {
      this.logger.error(
        `[BATCH_FENCE_LOST] ${label} 쓰기 생략 — 변형 lease 를 뺏긴 뒤였다. ` +
          `orderDelivery.id: ${orderDeliveryId}, orderId: ${orderId ?? 'N/A'}, ` +
          `claimToken: ${claimToken.toISOString()}`,
      );
      return false;
    }
    return true;
  }

  /**
   * 최초 발송 실패 시 환불 보류 여부 (B1/B3).
   * 비-SSG 는 보류(B1). SSG 는 발송 후 SsgInsertState 로 판단 — CONFIRMED/NONE/FAILED 는 보류,
   * ATTEMPTED(INSERT 응답 미확정)만 보류 제외(기존 refundForFail → resolver outcome 경로 유지).
   * SSG 행사잔액은 주문 시점 차감이라 최초실패 시점엔 고객+행사 차감이 둘 다 완료 → 보류 시 둘 다 유지된다.
   */
  private async shouldHoldRefundForFail(orderDelivery: OrderDeliveryEntity, order: OrderEntity): Promise<boolean> {
    if (order.type !== IOrderType.SSG) {
      return true;
    }
    const state = await this.ssgInsertStateService.getState(orderDelivery.id);
    return state !== SsgInsertState.ATTEMPTED;
  }

  /**
   * 단일 배송건 내부 처리 로직
   */
  private async processOneDeliveryInternal(
    orderDelivery: OrderDeliveryEntity,
    /**
     * 이 행에 대한 배치 소유 토큰(claimWaitDeliveries 가 claimed_at = mutation_claimed_at 로 함께 세팅).
     * 상태 쓰기의 fencing 조건으로 쓴다(다음 커밋). 없으면 종전대로 무울타리.
     */
    claimToken?: Date | null,
  ): Promise<{ deliveryHistory: DeliverySendHistoryEntity; orderId: number }> {
    const order = orderDelivery.orderProductMapping.order;
    const product = orderDelivery.orderProductMapping.product;
    const isChoiceCoupon = product.type === IProductType.CHOICE;
    const isEmailDelivery = orderDelivery.deliveryMethod === IOrderSendMethod.EMAIL;

    // B1/B3: 최초 발송 실패는 환불을 보류한다(구매/발송 미성립 → 복구 이벤트 미생성).
    // 진입 시점(발송 전) status 로 최초/재발송을 구분한다. 재발송이면 직전이 FAIL/FAIL_SMS.
    // SSG 보류 여부는 발송 후 SsgInsertState 에 달려 있어(issue() 후 전이) refund 지점에서
    // shouldHoldRefundForFail() 로 재평가한다 (여기선 최초 발송 여부만 snapshot).
    const isInitialSend =
      orderDelivery.status !== IOrderDeliveryStatus.FAIL && orderDelivery.status !== IOrderDeliveryStatus.FAIL_SMS;

    // 1. PIN 발급 (barCode가 없는 경우)
    if (!orderDelivery.barCode && !isChoiceCoupon && !isEmailDelivery) {
      try {
        let ssgEvent: SsgEventEntity | null = null;
        if (order.type === IOrderType.SSG && orderDelivery.ssgEventId) {
          ssgEvent = await this.ssgEventRepository.findOne({
            where: { id: orderDelivery.ssgEventId },
          });
        }

        await this.partnerCompanyExternService.issue(orderDelivery, ssgEvent);

        if (orderDelivery.status === IOrderDeliveryStatus.FAIL || !orderDelivery.barCode) {
          throw new Error('PIN 발급 실패');
        }

        orderDelivery.imagePath = await this.createCouponImage(orderDelivery);

        this.logger.log(
          `[BATCH] PIN 발급 성공 - orderDelivery.id: ${orderDelivery.id}, barCode: ${orderDelivery.barCode}`,
        );
      } catch (error) {
        this.logger.error(`[BATCH] PIN 발급 실패 - orderDelivery.id: ${orderDelivery.id}, error: ${error}`);

        // B1/B3: 최초 발송 실패는 환불 보류. SSG 는 ATTEMPTED 만 환불, 재발송 실패는 환불.
        const shouldHold = isInitialSend && (await this.shouldHoldRefundForFail(orderDelivery, order));
        if (!shouldHold) {
          await this.refundForFail(orderDelivery);
        }

        this.markSendFail(orderDelivery, IOrderDeliveryStatus.FAIL);
        // save(orderDelivery) 금지 — merge 는 claim 시점 스냅샷으로 행 전체를 쓴다. issue()(외부 통신,
        // 수 초) 동안 폐기·외부취소가 쓴 coupon_status=CANCEL 을 되돌리고 mutation_claimed_at 까지
        // 지운다(D3-60 clobber). markSendFail 이 쓰는 두 컬럼만 targeted update 한다.
        // + 그 사이 lease 를 뺏겼다면 남이 확정한 상태를 덮지 않는다(fencing, 리뷰 HIGH).
        await this.updateDeliveryOwned(
          orderDelivery.id,
          claimToken,
          { status: orderDelivery.status, failedAt: orderDelivery.failedAt },
          'PIN 발급 실패 상태',
          order.id,
        );

        // 실패해도 히스토리는 남김
        const deliveryHistory = new DeliverySendHistoryEntity();
        deliveryHistory.context = JSON.stringify(error);
        deliveryHistory.isSuccess = false;
        deliveryHistory.target = orderDelivery.deliveryTarget;
        deliveryHistory.deliveryMethod = orderDelivery.deliveryMethod;

        return { deliveryHistory, orderId: order.id };
      }
    }

    // 2. deliveryTarget 복호화
    const decryptedDeliveryTarget =
      this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.deliveryTarget) ?? orderDelivery.deliveryTarget;

    const title = orderDelivery.orderProductMapping.sendTitle ?? '';
    const deliveryMethod = orderDelivery.deliveryMethod;

    // 3. 유효기간 설정 (재발송 시 기존 expireAt 유지)
    if (order.type !== IOrderType.SSG && !orderDelivery.expireAt) {
      const expireDays = resolveExpireDays(
        orderDelivery.orderProductMapping.galaxiaDuration ?? product.galaxiaDuration,
        product.expireDay,
        product.partnerCompany?.validityStartsNextDay,
      );

      orderDelivery.expireAt = addDays(new Date(), expireDays);
      const encourageDay = orderDelivery.orderProductMapping.encourageDay;
      if (encourageDay) {
        orderDelivery.encourageAt = subDays(orderDelivery.expireAt, encourageDay);
      }
    }

    // 4. 이미지 보강: barCode 있는데 imagePath 없는 재처리 케이스 대응
    if (!isChoiceCoupon && !isEmailDelivery && orderDelivery.barCode && !orderDelivery.imagePath) {
      try {
        orderDelivery.imagePath = await this.createCouponImage(orderDelivery);
        this.logger.log(
          `[BATCH] 이미지 재생성 - orderDelivery.id: ${orderDelivery.id}, imagePath: ${orderDelivery.imagePath}`,
        );
      } catch (error) {
        this.logger.error(`[BATCH] 이미지 재생성 실패 - orderDelivery.id: ${orderDelivery.id}, error: ${error}`);
      }
    }

    // 5. 발송 텍스트 준비
    const filePathList: string[] = [];
    if (orderDelivery.imagePath) {
      filePathList.push(orderDelivery.imagePath);
    }

    const body = applyReplaceCharacters(orderDelivery.orderProductMapping.sendContent ?? '', orderDelivery);
    const memoRaw = orderDelivery.orderProductMapping.product.memo;
    const memo =
      memoRaw && order.type !== IOrderType.SSG && deliveryMethod !== IOrderSendMethod.EMAIL
        ? applyReplaceCharacters(memoRaw, orderDelivery)
        : null;
    const tailRaw = orderDelivery.orderProductMapping.sendTailText;
    const tailText = tailRaw ? applyReplaceCharacters(tailRaw, orderDelivery) : null;

    const deliveryHistory = new DeliverySendHistoryEntity();
    deliveryHistory.context = '{}';
    deliveryHistory.isSuccess = true;
    deliveryHistory.target = this.cryptoCipher.encryptDeliveryTarget(decryptedDeliveryTarget);
    deliveryHistory.deliveryMethod = deliveryMethod;

    const encryptKey = this.cryptoCipher.encryptJson(
      {
        id: orderDelivery.id,
        transactionId: orderDelivery.transactionId,
      } as OrderEncryptKey,
      couponTokenExpiry(orderDelivery.expireAt),
    );

    // 6. 발송 채널별 처리
    if (deliveryMethod === IOrderSendMethod.ALIM_TALK) {
      // ALIMTALK_ASYNC_REPORT: on 이면 POST 만 하고 수신확인을 reportSweep 로 분리(sendAlimTalkAsync),
      // off 면 기존 동기 inquiry 경로(sendAlimTalk). 두 메서드 시그니처 동일.
      const asyncReport = this.configService.get('ALIMTALK_ASYNC_REPORT') === 'true';
      const sendAlimTalkFn = asyncReport
        ? this.deliverySendService.sendAlimTalkAsync.bind(this.deliverySendService)
        : this.deliverySendService.sendAlimTalk.bind(this.deliverySendService);
      await sendAlimTalkFn(
        orderDelivery,
        decryptedDeliveryTarget,
        encryptKey,
        title,
        body,
        memo,
        tailText,
        filePathList,
        deliveryHistory,
      );
    } else if (deliveryMethod === IOrderSendMethod.MMS) {
      await this.deliverySendService.sendSms(
        orderDelivery,
        decryptedDeliveryTarget,
        encryptKey,
        title,
        body,
        memo,
        tailText,
        filePathList,
        deliveryHistory,
      );
    } else if (deliveryMethod === IOrderSendMethod.EMAIL) {
      const emailText = tailText ? `${body}\n\n${tailText}` : body;
      await this.deliverySendService.sendEmail(
        orderDelivery,
        decryptedDeliveryTarget,
        encryptKey,
        title,
        emailText,
        deliveryHistory,
      );
    }

    // 발송 결과(성공/실패)를 즉시 DB에 마커로 반영. 이후 refund/save가 실패해도
    // outer catch의 claimedAt reset은 status=WAIT 조건만 풀기 때문에 이미 COMPLETE/FAIL로
    // 반영된 행은 재시도되지 않아 중복 발송이 방지된다.
    // (이전에는 발송은 성공했는데 save가 실패하면 row가 WAIT 상태로 남아 다음 cron이 재발송했음)
    //
    // status update와 부가 컬럼 update를 분리한다.
    // - 1차(짧음): status/actualSendAt/failedAt만 갱신 → idx_order_delivery_claim 락을 짧게 잡고 빠르게 commit
    // - 2차: 나머지 부가 컬럼은 idx_order_delivery_claim에 무관하므로 락 footprint가 작음
    // 이렇게 분리해야 후속 cron의 claim 쿼리와 락 경쟁 시간을 최소화해 데드락 가능성을 줄인다.
    //
    // fencing: 발송(외부 통신)이 도는 사이 lease 가 stale 로 넘어가 폐기·외부취소가 상태를
    // 확정했을 수 있다. 내 소유가 유지될 때만 쓴다(리뷰 HIGH).
    const stillOwned = await this.updateDeliveryOwned(
      orderDelivery.id,
      claimToken,
      {
        status: orderDelivery.status,
        actualSendAt: orderDelivery.actualSendAt,
        failedAt: orderDelivery.failedAt,
        // HIGH: POST 성공 후 PENDING/msgKey 를 status 와 함께 즉시 영속 → 중간 실패 시에도
        // report_state=PENDING 이라 batch claim(report_state IS NULL) 이 재선택 안 함(중복 알림톡 차단).
        reportState: orderDelivery.reportState,
        alimTalkMsgKey: orderDelivery.alimTalkMsgKey,
        reportDeadlineAt: orderDelivery.reportDeadlineAt,
        reportNextDueAt: orderDelivery.reportNextDueAt,
        reportAttemptCount: orderDelivery.reportAttemptCount,
        reportFallbackAttemptCount: orderDelivery.reportFallbackAttemptCount,
      },
      '발송 결과',
      order.id,
    );
    // 1차에서 lease 상실이 확인됐다면 2차도 쓰지 않는다. 남이 소유한 행에 이미지/유효기간만
    // 남기면 "상태는 남의 것, 부가 컬럼은 내 것" 인 반쪽 행이 된다(경보는 1차에서 이미 나갔다).
    if (stillOwned) {
      await this.updateDeliveryOwned(
        orderDelivery.id,
        claimToken,
        {
          imagePath: orderDelivery.imagePath,
          expireAt: orderDelivery.expireAt,
          encourageAt: orderDelivery.encourageAt,
        },
        '발송 부가 컬럼',
        order.id,
      );
    }

    // 6. 발송 실패 시 환불 처리 (B1/B3: 최초 발송 실패는 보류, SSG 는 ATTEMPTED 만 환불, 재발송은 환불)
    //
    // ⚠️ 이 판정은 **메모리 status**로 한다 — 위 fencing 에서 stillOwned=false 여도(=lease 를
    //   뺏긴 뒤여도) 여기까지 온다. 일부러 여기서 stillOwned 로 막지 않는다:
    //   fencing 은 "상태 쓰기"의 소유권만 지키고, 환불의 이중집행 방지는 **별도 축**
    //   (refundForFail → refund-ledger 멱등 게이트, D3-3)이 맡는다. lease 를 훔쳐간 쪽
    //   (폐기·취소)이 자기 환불을 돌려도 같은 ledger 키라 이중환불이 안 난다.
    //   즉 fence 가 이 환불 분기까지 보호한다고 오해하면 안 된다 — 백스톱은 ledger 다.
    if (orderDelivery.status === IOrderDeliveryStatus.FAIL) {
      const shouldHold = isInitialSend && (await this.shouldHoldRefundForFail(orderDelivery, order));
      if (!shouldHold) {
        await this.refundForFail(orderDelivery);
      }
    }

    // 7. save(orderDelivery) 제거 (D3-60 clobber).
    //
    // merge 는 행 전체를 쓴다. 이 엔티티는 claim 시점 스냅샷이라 issue()/발송(외부 통신, 수 초)
    // 동안 다른 액터가 쓴 값을 되돌린다:
    //   - coupon_status='CANCEL' → 'NOT_USED'  (환불됐는데 살아있는 쿠폰)
    //   - mutation_claimed_at    → 스냅샷 값    (변형 lease 무력화)
    //   - deleted_at             → NULL         (soft-delete 된 행 부활)
    //
    // 이 메서드가 엔티티에 쓰는 컬럼은 imagePath/expireAt/encourageAt(위) 와
    // status/actualSendAt/failedAt/report*(markSendSuccess·markSendFail → 위 1차 update) 뿐이고,
    // 전부 앞의 targeted update 2개가 이미 영속했다. 발급 결과(barCode/personalCode/couponNum/
    // ssgTransactionId)는 issue() 가 자체 targeted update 로 반영한다.
    // → 여기서 추가로 쓸 컬럼이 없다.

    return { deliveryHistory, orderId: order.id };
  }

  async updateDeliveryStatusFromTracking(): Promise<void> {
    // 아직 배송이 끝나지 않은 상태만 조회
    const realOrders = await this.realProductOrderRepository.find({
      where: [
        { status: IOrderRealProductStatus.ORDER_COMPLETED },
        { status: IOrderRealProductStatus.STORAGE_COMPLETED },
        { status: IOrderRealProductStatus.DELIVERY_PROGRESS },
      ],
      relations: ['orderRealProductMappings'],
    });

    for (const realOrder of realOrders) {
      const mappings = realOrder.orderRealProductMappings;
      if (!mappings || mappings.length === 0) continue;

      // 비교 status 초기값(송장번호 입력) 설정
      let maxStatus: IOrderRealProductStatus = IOrderRealProductStatus.ORDER_COMPLETED;

      // 배송 완료인지 여부 (송장번호 없는 매핑이 있으면 false)
      let allDelivered = true;
      let hasError = false;

      for (const mapping of mappings) {
        // 운송장번호가 없으면
        if (!mapping.trackingNumber) {
          allDelivered = false;
          continue;
        }

        try {
          const response = await this.deliveryTrackHttp.trackDeliveryLastInfo('kr.cjlogistics', mapping.trackingNumber);
          const code = response?.data?.track?.lastEvent?.status?.code as DeliveryTrackingStatus;

          mapping.deliveryStatus = code ?? 'UNKNOWN';
          await this.realProductOrderMappingRepository.save(mapping);

          const mappedStatus = this.mapDeliveryCodeToOrderStatus(code);

          if (mappedStatus !== IOrderRealProductStatus.DELIVERY_COMPLETED) {
            allDelivered = false;
          }

          // 높은 우선 순위 : 송장번호 입력(ORDER_COMPLETE) > 입고(STORAGE_COMPLETED) > 배송중(DELIVERY_PROGRESS) > 배송완료(DELIVERY_COMPLETE)
          maxStatus = this.getHigherStatus(maxStatus, mappedStatus);
        } catch (error) {
          this.logger.error('배송 상태 조회에 실패했습니다' + error);
          allDelivered = false;
          hasError = true;
        }

        // 에러가 발생하지 않았을 때만 실행
        if (!hasError) {
          const orderStatus = allDelivered ? IOrderRealProductStatus.DELIVERY_COMPLETED : maxStatus;
          if (realOrder.status !== orderStatus) {
            realOrder.status = orderStatus;
            await this.realProductOrderRepository.save(realOrder);
          }
        }
      }
    }
  }

  private mapDeliveryCodeToOrderStatus(code: DeliveryTrackingStatus): IOrderRealProductStatus {
    switch (code) {
      case 'INFORMATION_RECEIVED':
      case 'AT_PICKUP':
        return IOrderRealProductStatus.STORAGE_COMPLETED;
      case 'IN_TRANSIT':
      case 'OUT_FOR_DELIVERY':
        return IOrderRealProductStatus.DELIVERY_PROGRESS;
      case 'DELIVERED':
        return IOrderRealProductStatus.DELIVERY_COMPLETED;
      default:
        return IOrderRealProductStatus.ORDER_COMPLETED;
    }
  }

  private getHigherStatus(current: IOrderRealProductStatus, next: IOrderRealProductStatus): IOrderRealProductStatus {
    const priority: Record<IOrderRealProductStatus, number> = {
      ORDER_PENDING: -1, // 사용하지 않음
      ORDER_CONFIRM: -1, // 사용하지 않음
      ORDER_CANCELED: -1, // 사용하지 않음
      ORDER_EDIT_REQUEST: -1, // 사용하지 않음

      ORDER_COMPLETED: 4,
      STORAGE_COMPLETED: 3,
      DELIVERY_PROGRESS: 2,
      DELIVERY_COMPLETED: 1,
    };

    return priority[next] > priority[current] ? next : current;
  }

  /**
   * SMS 발송 텍스트 구성
   * 순서: body(발신내용) → 핀번호/유효기간 → memo(상품유의사항) → tailText(꼬리 광고)
   */
  private buildSmsText(
    orderDelivery: OrderDeliveryEntity,
    encryptKey: string,
    body: string,
    memo?: string | null,
    tailText?: string | null,
  ): string {
    return this.deliverySendService.buildSmsText(orderDelivery, encryptKey, body, memo, tailText);
  }

  /**
   * 알림톡 실패 시 SMS fallback 발송
   */
  private async handleAlimTalkFail(
    orderDelivery: OrderDeliveryEntity,
    title: string,
    body: string,
    memo: string | null,
    tailText: string | null,
    filePathList: string[],
    decryptedDeliveryTarget: string,
    encryptKey: string,
    slotOp: DeliveryExclusiveOp,
  ): Promise<IOrderDeliveryStatus.COMPLETE_SMS | unknown> {
    try {
      const smsText = this.buildSmsText(orderDelivery, encryptKey, body, memo, tailText);
      const fromPhoneNumber = orderDelivery.orderProductMapping.fromPhoneNumber!;
      await this.messageAttemptService.trackSend(
        {
          orderDeliveryId: orderDelivery.id,
          slotOp,
          channel: MessageAttemptChannel.MMS,
          attemptType: MessageAttemptType.CHANNEL_FALLBACK,
          sendReason: 'ALIM_TALK_FALLBACK',
        },
        (attemptId) =>
          this.smsSend.send({
            msgType: 'M',
            to: decryptedDeliveryTarget,
            from: fromPhoneNumber,
            subject: title,
            text: smsText,
            filePath: filePathList,
            attemptId,
          }),
      );
      orderDelivery.status = IOrderDeliveryStatus.COMPLETE_SMS;
      return IOrderDeliveryStatus.COMPLETE_SMS;
    } catch (e) {
      this.markSendFail(orderDelivery, IOrderDeliveryStatus.FAIL_SMS);
      return e;
    }
  }

  /**
   * 재발송 시 PIN 재발급 및 이미지 재생성
   * - barCode가 없는 경우: PIN 재발급 + 이미지 생성 + 환불 복구
   * - barCode는 있는데 imagePath가 없는 경우: 이미지만 재생성
   * @returns true if successful or not needed, false if PIN reissue failed
   */
  private async reissuePinAndCreateImageIfNeeded(orderDelivery: OrderDeliveryEntity): Promise<boolean> {
    const order = orderDelivery.orderProductMapping.order;
    const product = orderDelivery.orderProductMapping.product;
    const isChoiceCoupon = product.type === IProductType.CHOICE;
    const isEmailDelivery = orderDelivery.deliveryMethod === IOrderSendMethod.EMAIL;

    // 초이스 쿠폰이나 이메일 발송은 PIN/이미지 재생성 대상 아님
    if (isChoiceCoupon || isEmailDelivery) {
      return true;
    }

    // Case 1: PIN 발급/확인 필요
    // - barCode 없음: PIN 재발급 필요
    // - SSG: barCode가 있어도 SSG DB 등록 여부 확인 필요 (SSG는 PIN을 로컬 생성 후 외부 API로 등록하는 구조)
    // - 단, SSG 발송 완료 건(COMPLETE/COMPLETE_SMS + barCode 존재)은 PIN 재발급 불필요 (CS 재전송 시 기존 barCode 유지)
    const isSsgAlreadyComplete =
      order.type === IOrderType.SSG &&
      orderDelivery.barCode &&
      (orderDelivery.status === IOrderDeliveryStatus.COMPLETE ||
        orderDelivery.status === IOrderDeliveryStatus.COMPLETE_SMS);
    const needsIssue = !orderDelivery.barCode || (order.type === IOrderType.SSG && !isSsgAlreadyComplete);
    if (needsIssue) {
      const hadNoBarCode = !orderDelivery.barCode;
      let ssgEvent: SsgEventEntity | null = null;
      let resendDeducted = false;
      // 재발송 선차감 단위 멱등키. deduct 시 발급 → 역복원(refundResendEventDeduction)이 이 키로 멱등 처리.
      // 원래 발송 실패 환불 cycle 의 refund_ledger_id 와 분리해 recovery_log 충돌(leak) 방지.
      let resendDeductionId: string | null = null;
      try {
        if (order.type === IOrderType.SSG && orderDelivery.ssgEventId) {
          ssgEvent = await this.ssgEventRepository.findOne({
            where: { id: orderDelivery.ssgEventId },
          });
        }

        // SSG FAIL 재발송: 잔액 충분한 행사 재선택 + 잔액 선차감.
        // plans/ssg-balance-refactor.md PR3.B + PR3 보강.
        // 세 신호 AND 가드 — 어느 하나도 빠지면 안 됨:
        //  (1) ledger exists           : 고객사 환불 발생 사실
        //  (2) state in NONE/FAILED    : SSG 등록 안 됐거나 실패 확정 (CONFIRMED 면 기존 PIN 재사용)
        //  (3) ledger.ssg_balance_settled : 이전 refundForFail() SSG 잔액 보정이 완료됨 (보강)
        // (3) 이 추가된 이유 — resolver 가 DEFERRED 반환했는데 새 행사에 또 선차감하면
        // 기존 행사 미복구 + 새 행사 차감 = SSG 측 잔액 이중. 보정 완료된 경우만 다음 선차감 허용.
        // 두 가드 사이 issue() 실행 중 다른 흐름이 release()/state 전이/markSsgSettled 를 끝낼 수
        // 있으므로 각 가드 시점에 새로 조회한다 (stale 캐시 사용 시 이중 차감/역환불 위험).
        const hasRefundLedgerForResendDeduct = await this.refundLedgerService.exists(orderDelivery.id);
        const ssgBalanceSettledForResendDeduct = hasRefundLedgerForResendDeduct
          ? await this.refundLedgerService.isSsgSettled(orderDelivery.id)
          : false;
        const stateForResendDeduct = await this.ssgInsertStateService.getState(orderDelivery.id);
        const canDeductNewEvent =
          stateForResendDeduct === SsgInsertState.NONE || stateForResendDeduct === SsgInsertState.FAILED;
        // B3: SSG FAIL 재발송에서 새 행사 선차감이 적용되는 케이스를 공통 가드로 묶는다.
        // (세 신호 AND: SSG + FAIL + canDeductNewEvent)
        const isSsgFailResendDeduct =
          order.type === IOrderType.SSG && orderDelivery.status === IOrderDeliveryStatus.FAIL && canDeductNewEvent;

        // B3: status=FAIL + state=NONE/FAILED + ledger 없음 = 보류(최초실패 환불 미생성) 정상 케이스.
        // 재발송은 기존 ssgEventId 로 PIN 재시도(새 행사 select·재차감 없음). 구버전 "비정상 경고"는
        // 보류 도입 후 오발이라 info 로 강등한다.
        if (isSsgFailResendDeduct && !hasRefundLedgerForResendDeduct) {
          this.logger.log(
            `[RESEND] SSG 보류 재발송 — status=FAIL + state=${stateForResendDeduct} + ledger 없음(정상). 기존 ssgEventId 로 PIN 재시도. orderDelivery.id=${orderDelivery.id}`,
          );
        }
        // SSG 잔액 보정 미완료 케이스 — 새 선차감 차단 + 운영 알림.
        if (isSsgFailResendDeduct && hasRefundLedgerForResendDeduct && !ssgBalanceSettledForResendDeduct) {
          this.logger.error(
            `[RESEND] SSG 잔액 보정 미완료(ssg_balance_settled=false) — 새 선차감 차단. 운영 점검 필요. orderDelivery.id=${orderDelivery.id}`,
          );
        }
        if (isSsgFailResendDeduct && hasRefundLedgerForResendDeduct && ssgBalanceSettledForResendDeduct) {
          const deduct = await this.ssgEventService.selectAndDeductForReissueWithPending({
            amount: product.price,
            orderId: order.id,
            couponExpiration: product.expireDay,
            purpose: 'BATCH_RESEND',
            issueOrderDeliveryId: orderDelivery.id,
          });
          if (!deduct) {
            this.logger.warn(
              `[RESEND] 잔액 충분한 SSG 행사 없음 - orderDelivery.id: ${orderDelivery.id}, price: ${product.price}`,
            );
            return false;
          }
          resendDeductionId = deduct.resendDeductionId;
          ssgEvent = deduct.event;
          resendDeducted = true;
        }

        // 선차감 pending 에 issue 시도 기록 — sweep 이 W1(미시도 직접 역복원)과 구분하는 phase.
        if (resendDeducted && resendDeductionId) {
          await this.ssgEventService.markReissueIssueAttempted(resendDeductionId, orderDelivery.id);
        }
        // resendDeductionId 전달 → issue() 가 기존/후보 PIN 재사용 시 pending 을 durable 'REUSED' 마킹(crash 안전).
        const issueResult = await this.partnerCompanyExternService.issue(
          orderDelivery,
          ssgEvent,
          resendDeductionId ?? undefined,
        );

        if (!orderDelivery.barCode) {
          this.logger.error(`[RESEND] PIN 재발급 실패 - orderDelivery.id: ${orderDelivery.id}`);
          if (resendDeducted && ssgEvent) {
            await this.refundResendDeduct(orderDelivery, ssgEvent.id, product.price, order.id, resendDeductionId!);
            resendDeducted = false;
          }
          return false;
        }

        // 선차감 정합(HIGH): issue() 가 신규 INSERT 로 선차감 행사를 실제 사용한 경우만 KEPT.
        // 기존/후보(legacy 등록) PIN 재사용 시엔 선차감 행사가 미사용 → 직접 역복원해야 이중차감을 막는다.
        if (resendDeducted && ssgEvent && resendDeductionId) {
          if (issueResult.ssgNewIssue) {
            // 신규 INSERT — 선차감 행사 실사용. ssgEventId durable 반영 후 pending KEPT.
            orderDelivery.ssgEventId = ssgEvent.id;
            await this.orderDeliveryRepository.update(orderDelivery.id, { ssgEventId: ssgEvent.id });
            await this.ssgEventService.resolveReissuePending(resendDeductionId, 'KEPT');
          } else {
            // 재사용 — 선차감 행사(미사용)를 state 비의존 직접 역복원(이중차감 방지). state 기반 resolver 는
            // 재사용 PIN 기준 CONFIRMED 를 새 선차감 확정으로 오판하므로 사용하지 않는다.
            this.logger.warn(
              `[RESEND] 선차감 행사 미사용(기존/후보 PIN 재사용) — 선차감 역복원. orderDelivery.id=${orderDelivery.id}, deductedEventId=${ssgEvent.id}, actualEventId=${issueResult.ssgEventId}`,
            );
            await this.reverseReissueDeductDirect(resendDeductionId, ssgEvent.id, order.id, product.price);
            resendDeducted = false;
            // ssgEventId 는 issue() 가 실제 귀속 행사로 이미 메모리/DB(markConfirmed) 반영. drift 시에만 보정.
            if (issueResult.ssgEventId != null) {
              orderDelivery.ssgEventId = issueResult.ssgEventId;
            }
          }
        }

        // 이전 실패로 환불된 금액 재차감 (PIN 실패든 발송 실패든)
        // SSG 선차감이 이미 완료된 경우 skipSsg=true
        // ledger row 가드: 실제 환불이 발생한 경우만 역차감. 환불 이력이 없으면 차감 상태 그대로이므로
        // 재차감하면 사용자 balance/allSettleAmount/SSG event balance가 이중차감된다.
        // issue() 동안 다른 흐름이 release()를 끝냈을 수 있으므로 최신 상태로 재조회한다.
        const hasRefundLedgerForReverse = await this.refundLedgerService.exists(orderDelivery.id);
        if ((hadNoBarCode || orderDelivery.status === IOrderDeliveryStatus.FAIL) && hasRefundLedgerForReverse) {
          await this.reverseRefundForResend(orderDelivery, resendDeducted);
        }

        this.logger.log(
          `[RESEND] PIN 발급/확인 성공 - orderDelivery.id: ${orderDelivery.id}, barCode: ${orderDelivery.barCode}`,
        );
      } catch (error) {
        this.logger.error(`[RESEND] PIN 발급/확인 실패 - orderDelivery.id: ${orderDelivery.id}, error: ${error}`);
        // issue() throw 시에도 선차감 환불 (shared resolver — state 기준 분기)
        if (resendDeducted && ssgEvent) {
          await this.refundResendDeduct(orderDelivery, ssgEvent.id, product.price, order.id, resendDeductionId!);
        }
        return false;
      }
    }

    // Case 2: barCode는 있는데 imagePath가 없는 경우 - 이미지만 재생성
    if (!orderDelivery.imagePath && orderDelivery.barCode) {
      try {
        const path = await this.createCouponImage(orderDelivery);
        orderDelivery.imagePath = path;

        this.logger.log(`[RESEND] 이미지 재생성 성공 - orderDelivery.id: ${orderDelivery.id}, imagePath: ${path}`);
      } catch (error) {
        this.logger.error(`[RESEND] 이미지 재생성 실패 - orderDelivery.id: ${orderDelivery.id}, error: ${error}`);
        // 이미지 생성 실패해도 텍스트만으로 발송 시도하도록 진행 (return false 하지 않음)
      }
    }

    return true;
  }

  /**
   * SSG 재발급용 행사 확보 + 선차감 (fail-fast).
   * 발급가능(잔액≥price) 행사를 선택하고 즉시 선차감한다. 행사 없으면 null(차감 X).
   * 반환된 resendDeductionId 는 실패 시 reverseSsgReissueDeduct 의 멱등키로 사용.
   */
  async selectAndDeductSsgEventForReissue(
    orderId: number,
    price: number,
    couponExpiration: number,
  ): Promise<{ event: SsgEventEntity; resendDeductionId: string } | null> {
    // CS 폐기후신규: 선차감 시점엔 신규 delivery 미존재 → issueOrderDeliveryId=null.
    // 신규 delivery 저장 후 markReissueIssueAttempted 로 실제 issue 대상 id 를 기록한다.
    return this.ssgEventService.selectAndDeductForReissueWithPending({
      amount: price,
      orderId,
      couponExpiration,
      purpose: 'CS_REISSUE',
      issueOrderDeliveryId: null,
    });
  }

  /**
   * SSG 재발급 선차감 역복원 (issue 실패 시). resolver 경유 state 분기 후 outcome 반환.
   * RESTORED = 미등록 확정(역복원 완료) / SKIPPED_CONFIRMED = 등록 확정(차감 유지) / DEFERRED = 불명.
   * caller(CS)는 outcome 으로 폐기 역전 여부를 결정한다.
   */
  async reverseSsgReissueDeduct(
    orderDelivery: OrderDeliveryEntity,
    ssgEventId: number,
    refundAmount: number,
    orderId: number,
    resendDeductionId: string,
  ): Promise<SsgRefundOutcome> {
    const outcome = await this.ssgRefundResolverService.resolveAndRefundIfNeeded({
      orderDeliveryId: orderDelivery.id,
      ssgEventId,
      refundAmount,
      orderId,
      resendDeductionId,
    });
    await this.resolveReissuePendingByOutcome(resendDeductionId, outcome);
    return outcome;
  }

  /**
   * issue() 미시도(미등록 확정) 구간 전용 선차감 직접 역복원.
   * resolver(state 기준)를 타면 기존 폐기 대상 delivery 의 CONFIRMED 를 새 선차감 확정으로 오판해
   * leak 이 생기므로(HIGH), 이 경로는 state 를 보지 않고 refundResendEventDeduction(멱등) 으로 즉시 역복원한다.
   * 실패 시 pending 미해소 → sweep(W1, issue_attempted_at IS NULL) 가 재시도.
   */
  async reverseReissueDeductDirect(
    resendDeductionId: string,
    ssgEventId: number,
    orderId: number,
    amount: number,
  ): Promise<void> {
    try {
      await this.ssgEventService.refundResendEventDeduction({ resendDeductionId, ssgEventId, orderId, amount });
      await this.ssgEventService.resolveReissuePending(resendDeductionId, 'REVERSED');
    } catch (e) {
      this.logger.error(
        `[RESEND] issue 전 선차감 직접 역복원 실패 — pending 미해소(sweep 재시도). resendDeductionId=${resendDeductionId}, error: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /**
   * CS 폐기후신규 경로용 passthrough — 선차감 pending 에 issue 시도(실제 신규 delivery id) 기록.
   * sweep 이 W1(미시도 직접 역복원)과 issue 시도(state 기준 확정)를 구분하는 phase 마킹.
   */
  async markReissueIssueAttempted(resendDeductionId: string, issueOrderDeliveryId: number): Promise<void> {
    await this.ssgEventService.markReissueIssueAttempted(resendDeductionId, issueOrderDeliveryId);
  }

  /**
   * CS 폐기후신규 경로용 passthrough — issue 성공 시 선차감 pending 을 KEPT 로 해소.
   */
  async resolveReissuePendingKept(resendDeductionId: string): Promise<void> {
    await this.ssgEventService.resolveReissuePending(resendDeductionId, 'KEPT');
  }

  /**
   * 선차감 pending 을 resolver outcome 으로 해소한다.
   * RESTORED→REVERSED(역복원됨) / SKIPPED_CONFIRMED→KEPT(등록 확정·차감 유지) / DEFERRED→유지(sweep 재시도).
   */
  private async resolveReissuePendingByOutcome(resendDeductionId: string, outcome: SsgRefundOutcome): Promise<void> {
    if (outcome === SsgRefundOutcome.RESTORED) {
      await this.ssgEventService.resolveReissuePending(resendDeductionId, 'REVERSED');
    } else if (outcome === SsgRefundOutcome.SKIPPED_CONFIRMED) {
      await this.ssgEventService.resolveReissuePending(resendDeductionId, 'KEPT');
    }
  }

  /**
   * 재발송 선차감 환불 (PIN 발급 실패 또는 issue() throw 시).
   * shared resolver 를 통해 state 기준으로 SSG 행사 잔액을 복구한다.
   * resendDeductionId 전달로 전용 멱등 경로(refundResendEventDeduction)를 사용하여
   * 원래 환불 cycle 의 recovery_log 키 충돌을 회피하고 settled 를 미터치한다.
   */
  private async refundResendDeduct(
    orderDelivery: OrderDeliveryEntity,
    ssgEventId: number,
    refundAmount: number,
    orderId: number,
    resendDeductionId: string,
  ): Promise<void> {
    const outcome = await this.ssgRefundResolverService.resolveAndRefundIfNeeded({
      orderDeliveryId: orderDelivery.id,
      ssgEventId,
      refundAmount,
      orderId,
      resendDeductionId,
    });
    await this.resolveReissuePendingByOutcome(resendDeductionId, outcome);
    if (outcome === SsgRefundOutcome.DEFERRED) {
      this.logger.error(`[RESEND] 선차감 환불 DEFERRED — 운영 점검 필요. orderDelivery.id: ${orderDelivery.id}`);
    }
  }

  /**
   * 환불 복구 (PIN 재발급 성공 시).
   * 최초 발송 실패 시 환불된 금액을 다시 차감하고 ledger row를 DELETE 하여
   * 향후 또 실패할 경우 다시 환불할 수 있도록 멱등 플래그를 해제한다.
   *
   * 라우팅은 refundForFail()과 동일한 기준을 역방향으로 적용:
   * - 정산확정 후(isSettleComplete=true) → balance에서 차감
   * - 미정산 + isSettleBalance=true → balance에서 차감
   * - 미정산 + isSettleBalance=false → allSettleAmount 가산
   *
   * 신호 분리 (plans/ssg-balance-refactor.md PR3.B):
   * - 고객사 환불 역처리 (balance/allSettleAmount 재차감): caller 가 ledger exists 가드로 진입 결정 → 항상 진행
   * - SSG 행사 chargeBack: SSG 분기 안에서 state + skipSsg 신호 독립 평가
   *     state=CONFIRMED → chargeBack X (등록 확정, 행사 잔액 손대지 않음)
   *     skipSsg=true   → chargeBack X (이미 새 행사로 선차감 이동, 기존 행사 손대지 않음)
   *
   * @param skipSsg SSG 선차감이 이미 완료된 경우 true (SSG chargeBack 스킵)
   */
  @Transactional()
  private async reverseRefundForResend(orderDelivery: OrderDeliveryEntity, skipSsg: boolean = false): Promise<void> {
    const order = orderDelivery.orderProductMapping.order;
    const mapping = orderDelivery.orderProductMapping;
    const productPrice = mapping.product.price;
    const settlementPrice = calculateSettlementPrice(mapping, order.cardSurchargeApplied, orderDelivery);
    const userId = order.clientUserId ?? order.user!.id;
    const shouldRestoreBalance = order.isSettleComplete || order.isSettleBalance;

    // idempotency 가드 — refund ledger 해제(release)를 가장 먼저 수행한다 (cls TX).
    // release() 는 ledger row 가 없으면 BadRequestException 을 throw 하므로, 중복/race(이미 다른 흐름이
    // 재발송 처리) 시 여기서 early return 해 이후 side effect(SSG chargeBack / 재차감 / wallet 역차감)가
    // 실행되지 않도록 막는다 → 선행 재차감 commit 으로 인한 이중 재차감 방지.
    // release 가 성공하고 이후 단계가 throw 하면 @Transactional 이 release 까지 함께 rollback (atomic).
    let reverseLedgerId: number | null = null;
    try {
      reverseLedgerId = await this.refundLedgerService.getLedgerId(orderDelivery.id);
      await this.refundLedgerService.release(orderDelivery.id);
    } catch (error) {
      if (error instanceof BadRequestException) {
        this.logger.warn(
          `[RESEND] 환불 복구 중복 차단 (정상) - orderDelivery.id: ${orderDelivery.id}, message: ${error.message}`,
        );
        return;
      }
      throw error;
    }

    // SSG chargeBack — external SSG-side state change. cls TX 밖 effect 라 try/흡수 (실패가 고객 재차감을 막지 않음).
    if (!skipSsg && order.type === IOrderType.SSG && orderDelivery.ssgEventId) {
      try {
        const state = await this.ssgInsertStateService.getState(orderDelivery.id);
        if (state === SsgInsertState.CONFIRMED) {
          this.logger.log(`[RESEND] SSG chargeBack skip — state=CONFIRMED. orderDelivery.id=${orderDelivery.id}`);
        } else {
          await this.ssgEventService.chargeBackForResend(orderDelivery.ssgEventId, order.id, productPrice);
        }
      } catch (ssgError) {
        this.logger.error(
          `[RESEND] SSG chargeBack 실패 — 고객 재차감은 계속 진행. orderDelivery.id=${orderDelivery.id}, error: ${ssgError}`,
        );
      }
    }

    // legacy mirror + wallet ledger/잔액 atomic — 본 메소드 @Transactional() 데코레이터 cls TX 사용.
    // userManagementService/refundLedgerService 가 cls-tracked manager 를 통해 자동으로 같은 TX 에 흡수.
    // 어느 단계라도 throw 시 전체 rollback → wallet/legacy drift 방지.
    if (shouldRestoreBalance) {
      await this.userManagementService.deductBalance(userId, settlementPrice, `재발송 역환불 (주문번호: ${order.id})`);
    } else {
      await this.userRepository
        .createQueryBuilder()
        .update()
        .set({ allSettleAmount: () => 'all_settle_amount + :amount' })
        .where('id = :id', { id: userId })
        .setParameters({ amount: settlementPrice })
        .execute();
    }

    // wallet 재차감 + refund ledger 역처리 — this.orderRepository.manager (cls-tracked) 로 same TX.
    const isWalletManaged = await this.walletManagedPredicate.isWalletManaged(order.id, this.orderRepository.manager);
    if (isWalletManaged) {
      await this.applyWalletReverseRefundForResendOnManager(orderDelivery, this.orderRepository.manager);
    } else if (!shouldRestoreBalance) {
      // 레거시(allocation 없음) 외상 재증가분을 wallet credit_used 에도 동기화 (drift 방지).
      await this.legacyWalletCreditSyncService.syncCredit(this.orderRepository.manager, {
        billingUserId: userId,
        orderId: order.id,
        orderDeliveryId: orderDelivery.id,
        delta: settlementPrice,
        type: 'RESEND_DEDUCT',
        memo: `재발송 역환불 재차감 (주문번호: ${order.id})`,
      });
    } else if (shouldRestoreBalance) {
      // 레거시(allocation 없음) 예치금 재차감분을 wallet deposit 에도 동기화 (drift 방지).
      // R-A fix: release() 이전에 캡처한 refund ledger PK(reverseLedgerId)로 cycle 을 결정론 키에 포함해
      // 다회 재발송(fail→release→re-fail) 시 cycle 별 재차감이 same-key no-op 으로 유실되지 않게 한다.
      await this.legacyWalletCreditSyncService.syncDeposit(this.orderRepository.manager, {
        billingUserId: userId,
        orderId: order.id,
        orderDeliveryId: orderDelivery.id,
        delta: -settlementPrice,
        type: 'RESEND_DEDUCT',
        idempotencyKey: `legacy_resend_deduct:${order.id}:${orderDelivery.id}:${reverseLedgerId}:deposit`,
        memo: `재발송 역환불 (주문번호: ${order.id})`,
      });
    }

    this.logger.log(
      `[RESEND] 환불 복구 완료 (atomic) - orderDelivery.id: ${orderDelivery.id}, amount: ${settlementPrice} (정가: ${productPrice})`,
    );
  }

  /**
   * 재발송 wallet 처리 — 단일 트랜잭션으로 attempt INSERT + reverseRefund + resendDeduct atomic.
   *   1) RESEND attempt row INSERT (cycle id 발급).
   *   2) 최신 active refund ledger row 찾기 → reverseRefund (counters 복원 + reversed_at set).
   *   3) ResendDeductService.resendDeduct (wallet_account 재차감 + wallet_transaction row split).
   *
   * dataSource.transaction 으로 한 묶음 — reverseRefund/resendDeduct 어느 단계라도 실패 시
   * 전체 rollback. caller (reissuePinAndCreateImageIfNeeded) 에 throw 전파해 발송 진행 중단.
   *
   * 다중 active ledger 안전 가드: candidates 안에 delivery 매칭 row 가 2건 이상이면 silent
   * 잘못된 reverse 위험 → explicit throw (부분환불 도입 시점에 검토 필요).
   */
  private async applyWalletReverseRefundForResendOnManager(
    orderDelivery: OrderDeliveryEntity,
    manager: import('typeorm').EntityManager,
  ): Promise<void> {
    const order = orderDelivery.orderProductMapping.order;

    // 1) RESEND attempt row 생성 — cycle id 사용
    const attempt = await manager.save(OrderDeliveryAttemptEntity, {
      orderDeliveryId: orderDelivery.id,
      attemptType: OrderDeliveryAttemptType.RESEND,
      status: OrderDeliveryAttemptStatus.DEDUCTED,
      deductedAt: new Date(),
    });

    // 2) 최신 active refund ledger row lookup (allocation 기준 + affectedDeliveryIds 포함)
    const allocation = await manager.findOne(OrderPaymentAllocationEntity, {
      where: { orderId: order.id },
    });
    if (!allocation) {
      throw new Error(`wallet-managed but allocation row missing for orderId=${order.id}`);
    }
    const candidates = await manager.find(OrderPaymentRefundEventEntity, {
      where: { allocationId: allocation.id, reversedAt: IsNull() },
      order: { id: 'DESC' },
    });
    const matchingLedgers = candidates.filter(
      (c) => Array.isArray(c.affectedDeliveryIds) && c.affectedDeliveryIds.includes(orderDelivery.id),
    );
    if (matchingLedgers.length === 0) {
      throw new Error(
        `wallet-managed reverseRefundForResend: no active refund ledger for delivery=${orderDelivery.id}`,
      );
    }
    if (matchingLedgers.length > 1) {
      // 부분환불/다중 ledger 도입 시점에 명시 정책 필요. 현재 단일 ledger invariant 위반 시 abort.
      throw new Error(
        `wallet-managed reverseRefundForResend: multiple active ledgers for delivery=${orderDelivery.id} ` +
          `(count=${matchingLedgers.length}). aborting to avoid silent mis-reverse.`,
      );
    }
    const ledger = matchingLedgers[0];

    // 3) reverseRefund + resendDeduct — caller TX manager 그대로 전파.
    //    재차감 금액은 line 분배가 아니라 reversed ledger 의 실제 복구 재원별 금액을 그대로 사용한다.
    //    (풀 기반 환불은 line 의 발송확정 분배와 다른 재원을 복구할 수 있어, line 사용 시 재원별 잔액 drift.)
    await this.refundPoolService.reverseRefund(ledger.id, attempt.id, manager);
    await this.resendDeductService.resendDeduct(
      {
        orderId: order.id,
        orderDeliveryId: orderDelivery.id,
        attemptId: attempt.id,
        depositAmount: ledger.refundedDepositAmount,
        creditAmount: ledger.refundedCreditUsedAmount,
        excessAmount: ledger.refundedCreditExcessAmount,
      },
      manager,
    );

    this.logger.log(
      `[RESEND] wallet path complete - orderDelivery.id=${orderDelivery.id}, attemptId=${attempt.id}, ledgerId=${ledger.id}`,
    );
  }

  /**
   * CS 재전송용 MMS 발송 (부작용 없음)
   * - 유효기간 재계산 안 함
   * - 상태 변경 안 함
   * - PIN 재발급 안 함
   * - 이미지 없으면 기존 barCode로 생성
   */
  async csResendAsMms(orderDeliveryId: number): Promise<void> {
    const dispatch = await this.prepareCouponResendDispatch(orderDeliveryId, MessageAttemptChannel.MMS);
    await this.messageAttemptService.trackSend(
      {
        orderDeliveryId,
        slotOp: DeliveryExclusiveOp.MANUAL_RESEND,
        channel: MessageAttemptChannel.MMS,
        attemptType: MessageAttemptType.MANUAL_RESEND,
        sendReason: 'CS_RESEND',
      },
      dispatch,
    );
  }

  /**
   * 재발송 payload 를 구성해 발송 클로저를 돌려준다 (CS 재발송·504 자동 재발송 `dueResend` 공용).
   *
   * - 유효기간 재계산·상태 변경·PIN 재발급을 하지 않는다(기존 barCode·수신정보 그대로).
   * - MMS 는 이미지가 유실됐으면 기존 barCode 로 재생성한다.
   * - 발급 전·삭제 건은 throw 로 거른다. 외부 호출은 반환된 클로저를 실행할 때만 일어난다.
   */
  async prepareCouponResendDispatch(
    orderDeliveryId: number,
    channel: MessageAttemptChannel.SMS | MessageAttemptChannel.MMS,
  ): Promise<(attemptId?: string) => Promise<SmsSendOut>> {
    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .leftJoinAndSelect('orderProductMapping.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .leftJoinAndSelect('choiceSelectProduct.brand', 'choiceBrand')
      .withDeleted()
      .where('orderDelivery.id = :id', { id: orderDeliveryId })
      .getOne();

    if (!orderDelivery) {
      throw new Error('발송 데이터가 존재하지 않습니다.');
    }

    this.assertChoiceProductNotDeletedForCsResend(orderDelivery);

    const isUnselectedChoiceCoupon =
      orderDelivery.orderProductMapping.product.type === IProductType.CHOICE && !orderDelivery.choiceSelectProductId;
    if (!orderDelivery.barCode && !isUnselectedChoiceCoupon) {
      throw new Error(
        `쿠폰이 발급되지 않은 건은 ${channel === MessageAttemptChannel.MMS ? 'MMS' : 'SMS'} 재발송이 불가능합니다.`,
      );
    }

    return channel === MessageAttemptChannel.MMS
      ? await this.buildMmsResendDispatch(orderDelivery, isUnselectedChoiceCoupon)
      : await this.buildSmsResendDispatch(orderDelivery, isUnselectedChoiceCoupon);
  }

  /** MMS 재발송 클로저 (기존 csResendAsMms 본문 추출 — 동작 불변). */
  private async buildMmsResendDispatch(
    orderDelivery: OrderDeliveryEntity,
    isUnselectedChoiceCoupon: boolean,
  ): Promise<(attemptId?: string) => Promise<SmsSendOut>> {
    // 이미지 없으면 기존 barCode로 생성 (초이스쿠폰 미선택 시 이미지 불필요)
    if (!orderDelivery.imagePath && !isUnselectedChoiceCoupon) {
      try {
        const path = await this.createCouponImage(orderDelivery);
        orderDelivery.imagePath = path;
        await this.orderDeliveryRepository.update(orderDelivery.id, { imagePath: path });
      } catch (error) {
        this.logger.error(`[CS_RESEND] 이미지 재생성 실패 - orderDelivery.id: ${orderDelivery.id}, error: ${error}`);
      }
    }

    // 수신 전화번호 결정
    const phoneNumber =
      orderDelivery.deliveryMethod === IOrderSendMethod.EMAIL && orderDelivery.emailReceiverPhone
        ? this.decryptDeliveryTarget(orderDelivery, 'emailReceiverPhone')
        : this.decryptDeliveryTarget(orderDelivery);

    // 텍스트 빌드
    const title = orderDelivery.orderProductMapping.sendTitle ?? '';
    const body = applyReplaceCharacters(orderDelivery.orderProductMapping.sendContent ?? '', orderDelivery);
    const memoSourceProduct = orderDelivery.choiceSelectProduct ?? orderDelivery.orderProductMapping.product;
    const memoRaw = memoSourceProduct.memo;
    const memo =
      memoRaw && orderDelivery.orderProductMapping.order.type !== IOrderType.SSG
        ? applyReplaceCharacters(memoRaw, orderDelivery)
        : null;
    const tailRaw = orderDelivery.orderProductMapping.sendTailText;
    const tailText = tailRaw ? applyReplaceCharacters(tailRaw, orderDelivery) : null;

    const encryptKey = this.cryptoCipher.encryptJson(
      {
        id: orderDelivery.id,
        transactionId: orderDelivery.transactionId,
      } as OrderEncryptKey,
      couponTokenExpiry(orderDelivery.expireAt),
    );

    const smsText = this.buildSmsText(orderDelivery, encryptKey, body, memo, tailText);

    const filePathList: string[] = [];
    if (orderDelivery.imagePath) {
      filePathList.push(orderDelivery.imagePath);
    }

    const fromPhoneNumber =
      orderDelivery.orderProductMapping.fromPhoneNumber ||
      (await this.orderFromService.resolveSendDefaultPhone(getBillingUserId(orderDelivery.orderProductMapping.order)));

    return (attemptId) =>
      this.smsSend.send({
        msgType: 'M',
        to: phoneNumber,
        from: fromPhoneNumber,
        subject: title,
        text: smsText,
        filePath: filePathList,
        attemptId,
      });
  }

  async csResendAsAlimTalk(
    orderDeliveryId: number,
  ): Promise<IOrderDeliveryStatus.COMPLETE | IOrderDeliveryStatus.COMPLETE_SMS> {
    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'company')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .leftJoinAndSelect('orderProductMapping.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .leftJoinAndSelect('choiceSelectProduct.brand', 'choiceBrand')
      .withDeleted()
      .where('orderDelivery.id = :id', { id: orderDeliveryId })
      .getOne();

    if (!orderDelivery) {
      throw new Error('발송 데이터가 존재하지 않습니다.');
    }

    this.assertChoiceProductNotDeletedForCsResend(orderDelivery);

    const isUnselectedChoiceCoupon =
      orderDelivery.orderProductMapping.product.type === IProductType.CHOICE && !orderDelivery.choiceSelectProductId;
    if (!orderDelivery.barCode && !isUnselectedChoiceCoupon) {
      throw new Error('쿠폰이 발급되지 않은 건은 알림톡 재발송이 불가능합니다.');
    }

    // 폴백 대비: 이미지 없으면 기존 barCode로 생성
    if (!orderDelivery.imagePath && !isUnselectedChoiceCoupon) {
      try {
        const path = await this.createCouponImage(orderDelivery);
        orderDelivery.imagePath = path;
        await this.orderDeliveryRepository.update(orderDelivery.id, { imagePath: path });
      } catch (error) {
        this.logger.error(`[CS_RESEND] 이미지 재생성 실패 - orderDelivery.id: ${orderDelivery.id}, error: ${error}`);
      }
    }

    // 수신 전화번호 결정
    const phoneNumber =
      orderDelivery.deliveryMethod === IOrderSendMethod.EMAIL && orderDelivery.emailReceiverPhone
        ? this.decryptDeliveryTarget(orderDelivery, 'emailReceiverPhone')
        : this.decryptDeliveryTarget(orderDelivery);

    const alimTalk = AlimTalkTemplate(orderDelivery);

    const encryptKey = this.cryptoCipher.encryptJson(
      {
        id: orderDelivery.id,
        transactionId: orderDelivery.transactionId,
      } as OrderEncryptKey,
      couponTokenExpiry(orderDelivery.expireAt),
    );

    // 알림톡 시도
    let alimTalkSucceeded = false;
    try {
      const { report } = await this.messageAttemptService.trackAlimTalk(
        {
          orderDeliveryId: orderDelivery.id,
          slotOp: DeliveryExclusiveOp.MANUAL_RESEND,
          attemptType: MessageAttemptType.MANUAL_RESEND,
          sendReason: 'CS_RESEND',
        },
        () =>
          this.deliveryAlimTalk.send({
            to: phoneNumber,
            text: alimTalk,
            encryptKey: encryptKey,
          }),
        (result) => result.report.code === 'A000',
      );
      alimTalkSucceeded = report.code === 'A000';
    } catch (e) {
      this.logger.warn(
        `[CS_RESEND] 알림톡 발송 실패, MMS 폴백 시도 - orderDelivery.id: ${orderDelivery.id}, error: ${e}`,
      );
    }

    if (alimTalkSucceeded) {
      return IOrderDeliveryStatus.COMPLETE;
    }

    // 폴백: MMS 발송
    const title = orderDelivery.orderProductMapping.sendTitle ?? '';
    const body = applyReplaceCharacters(orderDelivery.orderProductMapping.sendContent ?? '', orderDelivery);
    const memoSourceProduct = orderDelivery.choiceSelectProduct ?? orderDelivery.orderProductMapping.product;
    const memoRaw = memoSourceProduct.memo;
    const memo =
      memoRaw && orderDelivery.orderProductMapping.order.type !== IOrderType.SSG
        ? applyReplaceCharacters(memoRaw, orderDelivery)
        : null;
    const tailRaw = orderDelivery.orderProductMapping.sendTailText;
    const tailText = tailRaw ? applyReplaceCharacters(tailRaw, orderDelivery) : null;

    const smsText = this.buildSmsText(orderDelivery, encryptKey, body, memo, tailText);
    const filePathList: string[] = [];
    if (orderDelivery.imagePath) {
      filePathList.push(orderDelivery.imagePath);
    }
    const fromPhoneNumber =
      orderDelivery.orderProductMapping.fromPhoneNumber ||
      (await this.orderFromService.resolveSendDefaultPhone(getBillingUserId(orderDelivery.orderProductMapping.order)));

    await this.messageAttemptService.trackSend(
      {
        orderDeliveryId: orderDelivery.id,
        slotOp: DeliveryExclusiveOp.MANUAL_RESEND,
        channel: MessageAttemptChannel.MMS,
        attemptType: MessageAttemptType.CHANNEL_FALLBACK,
        sendReason: 'CS_ALIM_TALK_FALLBACK',
      },
      (attemptId) =>
        this.smsSend.send({
          msgType: 'M',
          to: phoneNumber,
          from: fromPhoneNumber,
          subject: title,
          text: smsText,
          filePath: filePathList,
          attemptId,
        }),
    );

    return IOrderDeliveryStatus.COMPLETE_SMS;
  }

  async csResendAsSms(orderDeliveryId: number): Promise<void> {
    const dispatch = await this.prepareCouponResendDispatch(orderDeliveryId, MessageAttemptChannel.SMS);
    await this.messageAttemptService.trackSend(
      {
        orderDeliveryId,
        slotOp: DeliveryExclusiveOp.MANUAL_RESEND,
        channel: MessageAttemptChannel.SMS,
        attemptType: MessageAttemptType.MANUAL_RESEND,
        sendReason: 'CS_RESEND',
      },
      dispatch,
    );
  }

  /** SMS 재발송 클로저 (기존 csResendAsSms 본문 추출 — 동작 불변). */
  private async buildSmsResendDispatch(
    orderDelivery: OrderDeliveryEntity,
    isUnselectedChoiceCoupon: boolean,
  ): Promise<(attemptId?: string) => Promise<SmsSendOut>> {
    // 수신 전화번호 결정
    const phoneNumber =
      orderDelivery.deliveryMethod === IOrderSendMethod.EMAIL && orderDelivery.emailReceiverPhone
        ? this.decryptDeliveryTarget(orderDelivery, 'emailReceiverPhone')
        : this.decryptDeliveryTarget(orderDelivery);

    // SMS 텍스트
    const orderType = orderDelivery.orderProductMapping.order.type;
    let text: string;
    if (isUnselectedChoiceCoupon) {
      // 초이스쿠폰 미선택: 상품선택 링크 재발송
      const encryptKey = this.cryptoCipher.encryptJson(
        {
          id: orderDelivery.id,
          transactionId: orderDelivery.transactionId,
        } as OrderEncryptKey,
        couponTokenExpiry(orderDelivery.expireAt),
      );
      const choiceUrl = this.configService.getOrThrow('SMS_CHOICE_URL');
      text = `초이스 쿠폰 받기 링크 : ${choiceUrl}/${encryptKey}`;
    } else if (orderType === IOrderType.SSG) {
      text = smsSsgShortTemplate(orderDelivery);
    } else {
      const displayProduct = orderDelivery.choiceSelectProduct ?? orderDelivery.orderProductMapping.product;
      const productName = displayProduct.name;
      const brandName =
        (orderDelivery.choiceSelectProduct?.brand ?? orderDelivery.orderProductMapping.product.brand)?.nameKorean ?? '';
      const expireDate = orderDelivery.expireAt ? format(orderDelivery.expireAt, 'yy/MM/dd') : '';
      text = `[${productName}]\n교환처:${brandName}\n쿠폰번호:${orderDelivery.barCode}\n${expireDate}까지`;
    }

    const textBytes = Buffer.byteLength(text, 'utf8');
    const msgType: 'S' | 'L' = textBytes <= 90 ? 'S' : 'L';
    const fromPhoneNumber =
      orderDelivery.orderProductMapping.fromPhoneNumber ||
      (await this.orderFromService.resolveSendDefaultPhone(getBillingUserId(orderDelivery.orderProductMapping.order)));

    return (attemptId) =>
      this.smsSend.send({
        msgType,
        to: phoneNumber,
        from: fromPhoneNumber,
        subject: msgType === 'L' ? ' ' : '',
        text,
        filePath: [],
        attemptId,
      });
  }

  async csResendAsEmail(orderDeliveryId: number): Promise<void> {
    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .leftJoinAndSelect('orderProductMapping.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .withDeleted()
      .where('orderDelivery.id = :id', { id: orderDeliveryId })
      .getOne();

    if (!orderDelivery) {
      throw new Error('발송 데이터가 존재하지 않습니다.');
    }

    this.assertChoiceProductNotDeletedForCsResend(orderDelivery);

    if (orderDelivery.deliveryMethod !== IOrderSendMethod.EMAIL) {
      throw new Error('이메일 발송 건만 이메일 재발송이 가능합니다.');
    }

    if (orderDelivery.barCode && orderDelivery.emailReceiverPhone) {
      throw new Error('이미 수령된 쿠폰은 이메일 재발송이 불가능합니다.');
    }

    const decryptedEmail = this.decryptDeliveryTarget(orderDelivery);
    const title = orderDelivery.orderProductMapping.sendTitle ?? '';
    let text = orderDelivery.orderProductMapping.sendContent ?? '';
    const sendTailText = orderDelivery.orderProductMapping.sendTailText;
    if (sendTailText) {
      text += `\n\n${sendTailText}`;
    }
    text = applyReplaceCharacters(text, orderDelivery);

    // 기존 인증코드 재사용 (미인증 & 미만료)
    let emailSendHistory = await this.emailSendHistoryRepository.findOne({
      where: {
        orderDeliveryId: orderDelivery.id,
        type: EmailType.COUPON,
        isCertified: false,
        expireAt: MoreThan(new Date()),
      },
    });

    if (!emailSendHistory) {
      emailSendHistory = new EmailSendHistoryEntity();
      emailSendHistory.orderDeliveryId = orderDelivery.id;
      emailSendHistory.email = this.cryptoCipher.encryptDeliveryTarget(decryptedEmail);
      emailSendHistory.type = EmailType.COUPON;
      emailSendHistory.code = generateRandomCode();
      emailSendHistory.expireAt = addDays(new Date(), EmailCertifyExpireDay);
      await this.emailSendHistoryRepository.save(emailSendHistory);
    }

    const encryptKeyEmail = this.cryptoCipher.encryptJson(
      {
        id: orderDelivery.id,
        transactionId: orderDelivery.transactionId,
        emailHistoryId: emailSendHistory.id,
      } as OrderEncryptKey,
      couponTokenExpiry(orderDelivery.expireAt),
    );

    const url = `${this.configService.getOrThrow('EMAIL_RECEIVE_URL')}/${encryptKeyEmail}`;
    let qrCodeImagePath = undefined;
    const emailSendType = orderDelivery.orderProductMapping.emailSendType;
    if (emailSendType === OrderEmailSendType.QR) {
      const qrCodeBuffer = await QRCode.toBuffer(url);
      const uuid = randomUUID();
      const fileName = `qr-codes/${uuid}.png`;
      const originalName = `${uuid}.png`;
      const fileUrl = await this.fileStorage.uploadImageFileWithBuffer(qrCodeBuffer, fileName, originalName);
      qrCodeImagePath = fileUrl.url;
    }

    const useEmailContent = orderDelivery.orderProductMapping.useEmailContent ?? '';
    const emailText = EmailDeliveryTemplate({
      topImagePath: orderDelivery.orderProductMapping.topImagePath,
      productImagePath: orderDelivery.orderProductMapping.product.imagePath,
      text,
      url,
      code: emailSendHistory.code!,
      useEmailContent,
      qrCodeImagePath,
    });

    const fromEmail = orderDelivery.orderProductMapping.fromEmail;
    await this.mailSend.send({
      saveSentMail: 'N',
      bcc: undefined,
      cc: undefined,
      content: emailText,
      subject: title,
      to: decryptedEmail,
      fromEmail,
    });
  }

  /**
   * oneSend 의 결과 영속 — save(orderDelivery) 금지, targeted update (D3-60 clobber).
   *
   * save 는 merge 라 **행 전체**를 claim 시점 스냅샷으로 쓴다. oneSend 는 PIN 발급·문자 발송
   * (외부 통신)으로 수 초가 걸리고, 변형 lease 는 5분 stale 이라 그 사이 폐기·외부취소가
   * lease 를 강탈해 들어올 수 있다. 그때 save 는 남이 쓴 값을 스냅샷으로 되돌린다:
   *   - coupon_status='CANCEL' → 'NOT_USED'   (환불은 끝났는데 되살아난 쿠폰 = 자금 손실)
   *   - deleted_at             → NULL          (unwindReissue 가 지운 tip 부활)
   *   - mutation_claimed_at    → 스냅샷 값      (남의 변형 lease 무력화)
   *
   * 아래 6개가 oneSend 가 엔티티에 쓰는 컬럼의 **전부**다(전수 확인):
   *   - status/actualSendAt/failedAt : markSendSuccess · markSendFail
   *   - expireAt/encourageAt         : 유효기간 신규 계산(재발송은 기존 값 유지)
   *   - imagePath                    : reissuePinAndCreateImageIfNeeded (자체 update 가 없는 유일한 컬럼)
   *
   * 나머지는 각자 자체 targeted update 로 이미 영속한다 —
   * barCode/personalCode/couponNum/ssgTransactionId 는 issue(), ssgEventId 는 재발급 분기,
   * transactionId 는 호출자의 claim CAS. 알림톡도 oneSend 는 **동기** 전송이라
   * reportState/msgKey 를 건드리지 않는다(비동기 sweep 은 배치 전용 경로).
   */
  private async persistOneSendResult(orderDelivery: OrderDeliveryEntity, leaseToken?: Date | null): Promise<void> {
    await this.updateDeliveryOwned(
      orderDelivery.id,
      leaseToken,
      {
        status: orderDelivery.status,
        actualSendAt: orderDelivery.actualSendAt,
        failedAt: orderDelivery.failedAt,
        expireAt: orderDelivery.expireAt,
        encourageAt: orderDelivery.encourageAt,
        imagePath: orderDelivery.imagePath,
      },
      'oneSend 발송 결과',
      orderDelivery.orderProductMapping?.order?.id,
    );
  }

  async oneSend(
    orderDelivery: OrderDeliveryEntity,
    isSave: boolean = true,
    testOrderDeliveryId?: number,
    /**
     * 호출자가 이 행에 대해 쥔 변형 lease 토큰(mutation_claimed_at 값).
     * 넘기면 발송 결과 쓰기가 그 소유 하에서만 이뤄진다(fencing). 없으면 종전대로 무울타리.
     * oneSend 는 배치·CS 재발송·발송실패내역 재발송·테스트발송이 함께 쓰는 진입점이라
     * 소유자가 호출자마다 달라 여기서 만들 수 없다.
     */
    leaseToken?: Date | null,
  ): Promise<boolean> {
    const order = orderDelivery.orderProductMapping.order;
    // 재발송인 경우 chargeBack 후 발송 실패 시 재환불이 필요한지 판단하기 위해 이전 상태 저장 (FAIL_SMS 포함)
    const wasFailBefore =
      !testOrderDeliveryId &&
      (orderDelivery.status === IOrderDeliveryStatus.FAIL || orderDelivery.status === IOrderDeliveryStatus.FAIL_SMS);

    // B1/B3: 실패 재발송 — 보류(환불 미생성)/환불됨 분기. snapshot 은 reissue 호출 *전* 에 잡는다
    // (reissue 내부 reverseRefundForResend 가 ledger 를 release 해 exists() 가 뒤집히기 때문).
    // refunded reverse 보강은 비-SSG 만(SSG refunded 는 reissue 내부에서 처리), held-slot 발급은 SSG 포함 wallet 전체.
    // 전환 건에서 점유할 배타 op — 실패 재발송이면 MANUAL_RESEND, 최초 발송이면 MESSAGE_SEND(§6.1 표 2-1).
    const sendSlotOp = wasFailBefore ? DeliveryExclusiveOp.MANUAL_RESEND : DeliveryExclusiveOp.MESSAGE_SEND;
    const isWalletManaged = wasFailBefore ? await this.walletManagedPredicate.isWalletManaged(order.id) : false;
    const refundLedgerBeforeReissue = wasFailBefore ? await this.refundLedgerService.exists(orderDelivery.id) : false;

    // PIN 재발급 및 이미지 재생성 (barCode나 imagePath가 없는 경우)
    // 테스트 발송은 mock 데이터(barCode='999999')를 사용하므로 PIN 재발급 불필요
    if (!testOrderDeliveryId) {
      const reissueSuccess = await this.reissuePinAndCreateImageIfNeeded(orderDelivery);
      if (!reissueSuccess) {
        // PIN 재발급 실패 시 발송 중단하고 실패 이력 기록
        const deliveryHistory = new DeliverySendHistoryEntity();
        deliveryHistory.context = 'PIN 재발급 실패';
        deliveryHistory.isSuccess = false;
        deliveryHistory.target = orderDelivery.deliveryTarget;
        deliveryHistory.deliveryMethod = orderDelivery.deliveryMethod;

        if (isSave) {
          await this.persistOneSendResult(orderDelivery, leaseToken);
        }
        await this.deliverySendHistoryRepository.save(deliveryHistory);
        return false;
      }
    }

    // B1/B3: reissue 성공 후, 발송 dispatch 전 — 실패 재발송 보정.
    if (wasFailBefore) {
      if (refundLedgerBeforeReissue) {
        // 환불됨 재발송. 비-SSG 만 여기서 보강한다 — reissue 의 needsIssue=false(barCode 보유) 케이스는
        // 내부 reverseRefundForResend 가 skip 되어 exists() 가 여전히 true → 명시 호출로 legacy mirror /
        // wallet 재차감 / RESEND attempt 를 보강한다. SSG refunded 는 reissue 내부(needsIssue=true)에서
        // reverseRefundForResend + RESEND attempt 를 생성하므로 여기서 중복 호출하지 않는다.
        if (order.type !== IOrderType.SSG && (await this.refundLedgerService.exists(orderDelivery.id))) {
          await this.reverseRefundForResend(orderDelivery, false);
        }
      } else if (isWalletManaged) {
        // 보류 재발송 (환불 미생성, wallet, SSG 포함) → RESEND attempt slot 선발급.
        // 미발급 시 재실패 refundForFail 의 fail_refund cycle 이 latest INITIAL attempt 로 떨어져
        // 이전 reversed ledger 와 같은 prefix → silent no-op(환불 누락) → 최신 RESEND attempt 를 가리키게 한다.
        await this.orderDeliveryAttemptRepository.save({
          orderDeliveryId: orderDelivery.id,
          attemptType: OrderDeliveryAttemptType.RESEND,
          status: OrderDeliveryAttemptStatus.DEDUCTED,
          deductedAt: new Date(),
        });
      }
    }

    const decryptedDeliveryTarget = this.decryptDeliveryTarget(orderDelivery);
    const title = orderDelivery.orderProductMapping.sendTitle ?? '';

    // 유효기간 설정 (재발송 시 기존 expireAt 유지)
    if (orderDelivery.orderProductMapping.order.type !== IOrderType.SSG && !orderDelivery.expireAt) {
      const expireDays = resolveExpireDays(
        orderDelivery.orderProductMapping.galaxiaDuration ?? orderDelivery.orderProductMapping.product.galaxiaDuration,
        orderDelivery.orderProductMapping.product.expireDay,
        orderDelivery.orderProductMapping.product.partnerCompany?.validityStartsNextDay,
      );

      orderDelivery.expireAt = addDays(new Date(), expireDays);
      // 상품별 독려문자 설정 적용
      const encourageDay = orderDelivery.orderProductMapping.encourageDay;
      if (encourageDay) {
        orderDelivery.encourageAt = subDays(orderDelivery.expireAt, encourageDay);
      }
    }

    const filePathList: string[] = [];
    if (orderDelivery.imagePath) {
      filePathList.push(orderDelivery.imagePath);
    }

    const deliveryMethod = orderDelivery.deliveryMethod;

    const body = applyReplaceCharacters(orderDelivery.orderProductMapping.sendContent ?? '', orderDelivery);
    const memoSourceProduct = orderDelivery.choiceSelectProduct ?? orderDelivery.orderProductMapping.product;
    const memoRaw = memoSourceProduct.memo;
    const memo =
      memoRaw &&
      deliveryMethod !== IOrderSendMethod.EMAIL &&
      orderDelivery.orderProductMapping.order.type !== IOrderType.SSG
        ? applyReplaceCharacters(memoRaw, orderDelivery)
        : null;
    const tailRaw = orderDelivery.orderProductMapping.sendTailText;
    const tailText = tailRaw ? applyReplaceCharacters(tailRaw, orderDelivery) : null;

    const deliveryHistory = new DeliverySendHistoryEntity();
    deliveryHistory.context = '{}';
    deliveryHistory.isSuccess = true;
    deliveryHistory.target = this.cryptoCipher.encryptDeliveryTarget(decryptedDeliveryTarget);
    deliveryHistory.deliveryMethod = deliveryMethod;

    // 테스트 발송인 경우 testOrderDeliveryId와 isTest 플래그 사용
    const encryptKey = this.cryptoCipher.encryptJson(
      {
        id: testOrderDeliveryId ?? orderDelivery.id,
        transactionId: orderDelivery.transactionId,
        isTest: !!testOrderDeliveryId,
      } as OrderEncryptKey,
      couponTokenExpiry(orderDelivery.expireAt),
    );

    // 알림톡 발송
    if (deliveryMethod === IOrderSendMethod.ALIM_TALK) {
      try {
        const alimTalk = AlimTalkTemplate(orderDelivery);
        const { responseData, report } = await this.messageAttemptService.trackAlimTalk(
          {
            orderDeliveryId: orderDelivery.id,
            slotOp: sendSlotOp,
            attemptType: wasFailBefore ? MessageAttemptType.MANUAL_RESEND : MessageAttemptType.INITIAL,
            sendReason: 'COUPON',
            skipTracking: !!testOrderDeliveryId,
          },
          () =>
            this.deliveryAlimTalk.send({
              to: decryptedDeliveryTarget,
              text: alimTalk,
              encryptKey: encryptKey,
            }),
          (result) => result.report.code === 'A000',
        );

        deliveryHistory.context = JSON.stringify(responseData);
        deliveryHistory.etcContext = JSON.stringify(report);

        if (report.code !== 'A000') {
          throw new Error('AlimTalk Send Error');
        }

        this.markSendSuccess(orderDelivery, IOrderDeliveryStatus.COMPLETE);
      } catch (e) {
        const errMsg = (e as Error)?.message ?? String(e);
        deliveryHistory.context = errMsg;
        deliveryHistory.isSuccess = false;
        const resultSms = await this.handleAlimTalkFail(
          orderDelivery,
          title,
          body,
          memo,
          tailText,
          filePathList,
          decryptedDeliveryTarget,
          encryptKey,
          sendSlotOp,
        );

        if (resultSms === IOrderDeliveryStatus.COMPLETE_SMS) {
          // 알림톡 실패 → SMS 폴백 성공 (정상 흐름이므로 에러 로그 남기지 않음)
          deliveryHistory.isSuccess = true;
          this.markSendSuccess(orderDelivery, IOrderDeliveryStatus.COMPLETE_SMS);
        } else {
          deliveryHistory.context += ` / smsResult=${resultSms}`;
          this.logSendFail(
            orderDelivery.id,
            'ALIM_TALK',
            { target: decryptedDeliveryTarget, test: !!testOrderDeliveryId, alimTalkErr: errMsg, smsResult: resultSms },
            e,
          );
          this.markSendFail(orderDelivery, IOrderDeliveryStatus.FAIL);
        }
      }
    }

    // SMS 발송
    if (deliveryMethod === IOrderSendMethod.MMS) {
      const smsText = this.buildSmsText(orderDelivery, encryptKey, body, memo, tailText);
      const fromPhoneNumber = orderDelivery.orderProductMapping.fromPhoneNumber!;

      try {
        await this.messageAttemptService.trackSend(
          {
            orderDeliveryId: orderDelivery.id,
            slotOp: sendSlotOp,
            channel: MessageAttemptChannel.MMS,
            attemptType: wasFailBefore ? MessageAttemptType.MANUAL_RESEND : MessageAttemptType.INITIAL,
            sendReason: 'COUPON',
            skipTracking: !!testOrderDeliveryId,
          },
          (attemptId) =>
            this.smsSend.send({
              msgType: 'M',
              to: decryptedDeliveryTarget,
              from: fromPhoneNumber,
              subject: title,
              text: smsText,
              filePath: filePathList,
              attemptId,
            }),
        );
        this.markSendSuccess(orderDelivery, IOrderDeliveryStatus.COMPLETE);
        deliveryHistory.context = smsText;
      } catch (e) {
        this.markSendFail(orderDelivery, IOrderDeliveryStatus.FAIL);
        this.logSendFail(
          orderDelivery.id,
          'MMS',
          { target: decryptedDeliveryTarget, from: fromPhoneNumber, test: !!testOrderDeliveryId },
          e,
        );
        deliveryHistory.context = (e as Error)?.message ?? String(e);
        deliveryHistory.isSuccess = false;
      }
    }

    // 이메일 발송
    if (deliveryMethod === IOrderSendMethod.EMAIL) {
      const emailText = tailText ? `${body}\n\n${tailText}` : body;

      // 이메일 쿠폰이 이미 수령되어 핀이 발급된 경우 (barCode가 있고 emailReceiverPhone이 있는 경우)
      // 이메일 대신 문자로 재발송
      if (orderDelivery.barCode && orderDelivery.emailReceiverPhone) {
        const decryptedEmailReceiverPhone =
          this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.emailReceiverPhone) ??
          orderDelivery.emailReceiverPhone;
        const fromPhoneNumber = orderDelivery.orderProductMapping.fromPhoneNumber!;

        try {
          await this.messageAttemptService.trackSend(
            {
              orderDeliveryId: orderDelivery.id,
              slotOp: sendSlotOp,
              channel: MessageAttemptChannel.MMS,
              attemptType: wasFailBefore ? MessageAttemptType.MANUAL_RESEND : MessageAttemptType.INITIAL,
              sendReason: 'EMAIL_SMS_RESEND',
              skipTracking: !!testOrderDeliveryId,
            },
            (attemptId) =>
              this.smsSend.send({
                msgType: 'M',
                to: decryptedEmailReceiverPhone,
                from: fromPhoneNumber,
                subject: title,
                text: emailText,
                filePath: filePathList,
                attemptId,
              }),
          );
          this.markSendSuccess(orderDelivery, IOrderDeliveryStatus.COMPLETE);
          deliveryHistory.context = emailText;
          deliveryHistory.target = this.cryptoCipher.encryptDeliveryTarget(decryptedEmailReceiverPhone);
        } catch (e) {
          this.markSendFail(orderDelivery, IOrderDeliveryStatus.FAIL);
          this.logSendFail(
            orderDelivery.id,
            'EMAIL_SMS_RESEND',
            { target: decryptedEmailReceiverPhone, from: fromPhoneNumber, test: !!testOrderDeliveryId },
            e,
          );
          deliveryHistory.context = (e as Error)?.message ?? String(e);
          deliveryHistory.isSuccess = false;
        }
      } else {
        // 핀이 발급되지 않은 경우: 이메일로 쿠폰 수령 링크 발송
        // 기존 인증코드가 있으면 재사용 (미인증 & 미만료)
        let emailSendHistory = await this.emailSendHistoryRepository.findOne({
          where: {
            orderDeliveryId: orderDelivery.id,
            type: EmailType.COUPON,
            isCertified: false,
            expireAt: MoreThan(new Date()),
          },
        });

        if (!emailSendHistory) {
          // 기존 인증코드가 없거나 만료된 경우 새로 생성
          emailSendHistory = new EmailSendHistoryEntity();
          emailSendHistory.orderDeliveryId = orderDelivery.id;
          emailSendHistory.email = this.cryptoCipher.encryptDeliveryTarget(decryptedDeliveryTarget);
          emailSendHistory.type = EmailType.COUPON;
          emailSendHistory.code = generateRandomCode();
          emailSendHistory.expireAt = addDays(new Date(), EmailCertifyExpireDay);
          await this.emailSendHistoryRepository.save(emailSendHistory);
        }

        // 테스트 발송인 경우 testOrderDeliveryId 사용
        const encryptKeyEmail = this.cryptoCipher.encryptJson(
          {
            id: testOrderDeliveryId ?? orderDelivery.id,
            transactionId: orderDelivery.transactionId,
            emailHistoryId: emailSendHistory.id,
            isTest: !!testOrderDeliveryId,
          } as OrderEncryptKey,
          couponTokenExpiry(orderDelivery.expireAt),
        );

        const url = `${this.configService.getOrThrow('EMAIL_RECEIVE_URL')}/${encryptKeyEmail}`;
        let qrCodeImagePath = undefined;
        const emailSendType = orderDelivery.orderProductMapping.emailSendType;
        if (emailSendType === OrderEmailSendType.QR) {
          const qrCodeBuffer = await QRCode.toBuffer(url);

          // 파일명 생성
          const uuid = randomUUID();
          const fileName = `qr-codes/${uuid}.png`;
          const originalName = `${uuid}.png`;

          const fileUrl = await this.fileStorage.uploadImageFileWithBuffer(qrCodeBuffer, fileName, originalName);
          qrCodeImagePath = fileUrl.url;
        }

        const useEmailContent = orderDelivery.orderProductMapping.useEmailContent ?? '';
        const renderedEmail = EmailDeliveryTemplate({
          topImagePath: orderDelivery.orderProductMapping.topImagePath,
          productImagePath: orderDelivery.orderProductMapping.product.imagePath,
          text: emailText,
          url: url,
          code: emailSendHistory.code!,
          useEmailContent,
          qrCodeImagePath,
        });

        const fromEmail = orderDelivery.orderProductMapping.fromEmail;

        try {
          await this.mailSend.send({
            saveSentMail: 'N',
            bcc: undefined,
            cc: undefined,
            content: renderedEmail,
            subject: title,
            to: decryptedDeliveryTarget,
            fromEmail: fromEmail,
          });
          this.markSendSuccess(orderDelivery, IOrderDeliveryStatus.COMPLETE);
          deliveryHistory.context = emailText;
        } catch (e) {
          this.markSendFail(orderDelivery, IOrderDeliveryStatus.FAIL);
          this.logSendFail(
            orderDelivery.id,
            'EMAIL',
            { target: decryptedDeliveryTarget, fromEmail: fromEmail, test: !!testOrderDeliveryId },
            e,
          );
          deliveryHistory.context = (e as Error)?.message ?? String(e);
          deliveryHistory.isSuccess = false;
        }
      }
    }

    // 재발송 시 chargeBack 후 발송이 다시 실패한 경우: 환불 복구 (FAIL_SMS 포함)
    if (
      wasFailBefore &&
      (orderDelivery.status === IOrderDeliveryStatus.FAIL || orderDelivery.status === IOrderDeliveryStatus.FAIL_SMS)
    ) {
      await this.refundForFail(orderDelivery);
    }

    if (isSave) {
      await this.persistOneSendResult(orderDelivery, leaseToken);
    }

    // 테스트 발송은 발송실패내역(delivery_send_history)에 기록하지 않는다.
    // 실패 원인은 위 catch 블록의 logger.error 로그로만 추적한다.
    if (!testOrderDeliveryId) {
      await this.deliverySendHistoryRepository.save(deliveryHistory);
    }

    return (
      orderDelivery.status === IOrderDeliveryStatus.COMPLETE ||
      orderDelivery.status === IOrderDeliveryStatus.COMPLETE_SMS
    );
  }

  /**
   * 쿠폰 유효기간이 만료된 이미지 파일 정리
   * expireAt + 1일이 지난 orderDelivery의 imagePath 파일을 삭제하고 DB에서 경로 초기화
   */
  async cleanupExpiredCouponImages() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    // 유효기간 만료+1일 지난 건 중 imagePath가 있는 건 조회
    const expiredDeliveries = await this.orderDeliveryRepository
      .createQueryBuilder('od')
      .select(['od.id', 'od.imagePath'])
      .where('od.imagePath IS NOT NULL')
      .andWhere('od.expireAt IS NOT NULL')
      .andWhere('od.expireAt < :yesterday', { yesterday })
      .getMany();

    if (expiredDeliveries.length === 0) return;

    let deletedCount = 0;
    for (const od of expiredDeliveries) {
      try {
        await fsPromises.unlink(od.imagePath!);
        deletedCount++;
      } catch {
        // 이미 삭제되었거나 접근 불가 - 무시
      }
    }

    // DB에서 imagePath 일괄 초기화
    const ids = expiredDeliveries.map((od) => od.id);
    await this.orderDeliveryRepository.update(ids, { imagePath: null });

    this.logger.log(`[CLEANUP] 만료 쿠폰 이미지 정리: ${deletedCount}건 삭제, ${ids.length}건 DB 초기화`);
  }

  @Transactional()
  async deliveryDeliveryTargetDestroy() {
    const now = new Date();
    const destroyValue = '-';

    const orderDeliveryList = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .withDeleted() // 폐기후재발행 롤백으로 soft-delete 된 행도 파기 (조기파기와 동일 집합)
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .where(
        // 파기 기준은 날짜(DATE) 단위 절삭 — "발송요청일 + N일". 시각(datetime) 비교면 자정 크론이
        // 그날 발송요청 시각 이후 몫을 다음 날로 미뤄, 파기예정일 당일 내내 미파기 상태가 됐다
        // (0710/backend-response 문서 2번). TZ/DB 커넥션 모두 KST(+09:00)라 DATE() 는 KST 날짜다.
        `DATE_ADD(DATE(orderProductMapping.sendRequestAt), INTERVAL orderProductMapping.requestToDestroyPersonalInfoDay DAY) <= DATE(:now)`,
        { now },
      )
      .andWhere('order.status = :status', { status: IOrderStatus.DELIVERY_COMPLETE })
      // 환불 진행중(PROGRESS/APPROVE)인 건은 제외 — 조기파기(executeRequest) 환불 가드 미러링.
      // 계좌/수신처를 환불 처리 중에 지우면 환불이 깨지므로, 환불 완료(또는 환불 없음) 후 다음 회차에 파기.
      .andWhere(
        '(orderDelivery.refundStatus IS NULL OR orderDelivery.refundStatus NOT IN (:...activeRefundStatuses))',
        { activeRefundStatuses: [OrderDeliveryRefundStatusEnum.PROGRESS, OrderDeliveryRefundStatusEnum.APPROVE] },
      )
      .andWhere(
        // PII 5종 중 하나라도 미파기면 대상 — 조기파기(executeRequest)와 동일 집합(H-1).
        // 과거에 일부만 파기된 행(예: deliveryTarget 만 '-')도 backfill.
        // (NULL 컬럼은 `!= '-'` 가 NULL 이라 이 절로 추가 매칭되지 않음 → 무중단)
        '(orderDelivery.deliveryTarget != :destroyValue OR orderDelivery.originalDeliveryTarget != :destroyValue OR orderDelivery.emailReceiverPhone != :destroyValue OR orderDelivery.bankAccount != :destroyValue OR orderDelivery.bankAccountOwner != :destroyValue)',
        { destroyValue },
      )
      // ── 유효기간 가드 ────────────────────────────────────────────────────────────
      // 유효기간이 파기예정일보다 뒤인 상품(예: 유효기간 5년 / 파기 180일)은 만료 전까지 파기를 미룬다.
      //   실효 파기예정일 = MAX(발송요청일 + N일, 유효기간 만료일 + 1일)
      // 수신처를 만료 전에 지우면 안 되는 이유는 셋인데, **적용 범위가 서로 다르다**:
      //   · CS 대응 — 보류 집합 전체에 적용된다. 수신처가 '-' 면 CS 재발송이 '파기된 발송
      //     정보입니다.' 로 차단된다(customer.service.service.ts:1051).
      //   · 재발송 — CANCEL/REFUND_CANCEL 은 UNSENDABLE_COUPON_STATUSES 로 이미 차단돼 있어
      //     (order.delivery.mutation.claim.ts:33) 이 명분이 적용되지 않는다.
      //   · 만료 안내 독려문자 — handleDeliveryEncourage 가 couponStatus=NOT_USED 이고
      //     status IN (COMPLETE, COMPLETE_SMS) 인 건만 대상으로 하므로(아래 handleDeliveryEncourage
      //     참조) USED·CANCEL·FAIL 에는 적용되지 않는다.
      // 즉 보류 집합 전체를 정당화하는 명분은 CS 대응 하나다. 나머지 둘은 부분집합에만 걸린다.
      //
      // 만료 후 재포착: 보류된 행은 PII 5종이 모두 원값이라 위 미파기 절(:3158)이 계속 참이고, 주 날짜
      // 절도 한 번 참이 되면 계속 참이므로, 만료 다음 날 자정 회차에서 자동으로 파기된다.
      //  단 **파기일수 상향 편집과 주문 상태 이탈이 없다는 전제**에서다 —
      //  updateDestroyPersonalInfoDay 에는 상태 검사가 없어 기준일이 뒤로 밀릴 수 있고,
      //  주문이 DELIVERY_COMPLETE 를 이탈하면 절 2) 가 깨져 아예 파기되지 않는다.
      // 보류 기간에도 매 회차 후보군에는 남아 있다가 이 가드 절에서만 걸러진다.
      //
      // **발송 실패(status=FAIL) 건도 보류된다** — 다른 행과 같은 이유, 즉 살아있는 expireAt 때문이다.
      // PIN 발급까지 성공한 뒤 발송에서 실패하면 expireAt 이 영속되므로(:1441, 그리고 :1565 의
      // updateDeliveryOwned('발송 부가 컬럼')) 가드가 그대로 걸린다. 부수적으로 couponStatus 는
      // NOT_USED 로 남고 최초 실패는 환불이 보류될 수 있어 refundStatus 도 NULL 이라 다른 가드에도
      // 걸리지 않아, 실제로 보류가 성립한다. 재발송이 유일한 구제책인 집합이라 이 포함은 의도된
      // 것이다. 발송 성공 건으로 좁히려면 status IN (COMPLETE, COMPLETE_SMS) 를 이 절에 추가해야
      // 하지만, 그러면 정작 재발송이 필요한 실패 건이 먼저 파기된다.
      //
      // [AND 로 덧붙는 절이므로 파기 대상을 좁히기만 한다 — 이 변경으로 새로 파기되는 건은 없다]
      // 아래 3개 절은 반드시 OR 로 묶인다. AND 로 바꾸면 "3개를 모두 만족해야 파기"가 되어 의미가
      // 정반대로 뒤집히고 대량 미파기가 발생한다(target-destroy.spec 이 OR 개수로 이를 고정한다).
      //
      // 각 절은 "가드를 적용하지 않는다 = 종전 정책대로 즉시 파기한다" 는 뜻이다(파기 면제가 아니다).
      //
      // ※ 판정 기준은 **쿠폰 상태가 아니라 유효기간 하나**다. 유효기간이 남아 있으면 사용/폐기/
      //   환불폐기 여부와 무관하게 파기하지 않는다(운영 결정). 사용 완료(USED) 건도 유효기간
      //   동안은 조회·CS 대응 대상으로 남겨야 한다는 요구에서 나온 규칙이라, couponStatus 로
      //   좁히는 절을 두지 않는다.
      //
      //   [보유기간에 대한 기록 — 다음 사람이 알아야 할 사실]
      //   이 규칙의 대가로 PII 실보유기간이 최대 유효기간(5년)까지 늘어난다. 반면 주문 화면의
      //   파기일수는 60/180일 프리셋과 '기타' 직접입력으로 받고, 62~180 범위 검사는 일부 화면의
      //   onBlur 에만 걸려 있다(프리셋 60 은 그 검사를 타지 않는다). 어느 쪽이든 실제 보관기간
      //   (유효기간)보다 훨씬 짧은 값이라, 운영자·고객사가 인식하는 기간과 실제가 어긋난다.
      //   **실무진이 이 괴리를 인지한 상태에서 현행대로 진행하기로 결정했다.** 놓친 것이 아니라
      //   알고서 수용한 것이다. 신규 정책도 아니어서, 구 이팝콘 프로그램에서부터 같은 방식으로
      //   운영해 왔다 — 유효기간이 남은 쿠폰의 CS 대응을 보유기간 최소화보다 우선한 판단이다.
      //   따라서 이 주석을 근거로 "미검토 리스크"를 다시 제기할 필요는 없다.
      //   (승인 근거 문서는 이 레포에 없다 — 이력이 필요하면 운영팀에 확인할 것.)
      //
      //   [보류 대상이 '행 전체'라는 점 — 별도로 확인받은 사항]
      //   이 가드는 행 단위로 걸리므로, 쿠폰 유효기간과 직접 관련이 없는 **환불 계좌**
      //   (bankAccount / bankAccountOwner)도 함께 최대 5년 보관된다. 가드를 만든 명분은 쿠폰
      //   CS 대응인데 금융 PII 까지 같은 기간 묶이는 셈이라 축이 다르다.
      //   → 이 축도 **확인 후 현행 유지로 결정**했다. 환불 문의 역시 유효기간 동안 들어올 수
      //     있으므로 계좌 정보도 그때까지 보유할 필요가 있다는 판단이다. 계좌 2종만 종전 일정대로
      //     파기하려면 UPDATE 를 두 갈래로 나누고 가드 절을 계좌에는 적용하지 않으면 되지만,
      //     지금은 의도적으로 그렇게 하지 않는다.
      //   실보유기간을 줄이는 방향으로 정책이 바뀐다면, 이 절에 couponStatus 조건을 되돌리는
      //   것이 아니라(그러면 CS 대응 요구가 다시 깨진다) 파기일수 입력 상한을 유효기간에 맞춰
      //   여는 쪽이 맞다.
      //
      // (번호는 아래 SQL 의 OR 항 순서와 같다)
      //
      //  1) expireAt IS NULL — [필수. 제거 금지]
      //     미발행 등 유효기간 자체가 없는 건. SQL 3값 논리상 `NULL < DATE(:now)` 는 거짓이
      //     아니라 NULL 이고 WHERE 는 TRUE 가 아닌 행을 버리므로, 이 절이 없으면 해당 건이 파기되지
      //     않는다. 종전(이 가드 이전)에는 정상 파기되던 집합이라 PII 사고다. 정책 논의 대상이 아니라
      //     정합성 방어이므로 지우지 말 것.
      //     · 정확히는 3절이 OR 라 `NULL OR TRUE = TRUE` 다. 이 절을 빼도 soft-delete 행은 여전히
      //       파기된다. 영구 미파기가 되는 건 `expireAt IS NULL` AND `deletedAt IS NULL` 인
      //       교집합, 즉 **PIN 미발급 모집단**이다. (발송실패 중에서도 발급 전에 실패한 건만이다 —
      //       발급 후 실패는 위에 적은 대로 expireAt 이 있어 이 교집합에 들지 않는다.)
      //
      //  2) DATE(expireAt) < DATE(:now) — [이 기능의 본체]
      //     만료 다음 날부터 파기한다. 만료 당일은 아직 쿠폰이 유효하므로 파기하지 않는다.
      //     날짜 절삭이라 expireAt 의 시분초는 판정에 영향을 주지 않는다(주 날짜 절과 같은 방식).
      //
      //  3) deletedAt IS NOT NULL — [정책 선택. 변경 가능]
      //     order_delivery 를 soft-delete 하는 경로는 레포 전체에 하나뿐이고, 지워지는 것은 재발행
      //     실패 시 unwindReissue 가 되감는 **신행(tip)** 이다 — 구행이 아니다
      //     (customer.service.service.ts:2219. 이 파일 :562 와 external.api.service.ts:1458 의
      //     기존 주석도 "unwindReissue 가 tip 을 softDelete" 로 서술한다).
      //     실물 쿠폰이 있다면 그것은 **원본(구행)** 쪽이다 — SSG 는 reverseDiscard 로 부활하고,
      //     비-SSG 는 협력사 취소된 채 남는다. 되감긴 tip 은 고객이 볼 쿠폰이 아니므로 유효기간이
      //     남아 있어도 붙잡지 않는다. 위 withDeleted() 가 이 행을 후보에 넣는 것과 짝을 이룬다.
      //     · 이 절이 잡는 행은 모두 couponStatus=CANCEL 이기도 하다 — softDelete 는
      //       `couponStatus=CANCEL` 플립이 성공했을 때만 실행되기 때문이다
      //       (customer.service.service.ts:2186-2232). 따라서 이 가드에 couponStatus 기반 절을
      //       추가하면 이 절과 완전히 겹쳐 이 절이 no-op 이 된다. 반대로 이 절을 지우면 그때는
      //       CANCEL 인 soft-delete tip 이 유효기간만큼 보류된다.
      //     · 다만 단독으로 잡는 구간은 좁다 — 되감긴 tip 은 대개 expireAt 이 NULL 이라 1) 이
      //       커버하고, 이 절만이 잡는 것은 'issue() 가 expireAt 을 영속한 뒤 barCode 누락으로
      //       unwind 된' 경우다(partner.company.extern.service.ts:198-206 의 markConfirmed 가 영속, 그 뒤
      //       customer.service.service.ts:2502 이 되감는다).
      //     · 빼면 그 구간의 PII 를 유효기간만큼(최대 5년) 더 보관하게 된다.
      //
      // 조기파기(EarlyDestroyService.executeRequest)에는 이 가드가 없다 — 의도된 비대칭이다.
      // 정기파기는 기한 도래로 기계가 일괄 수행하지만, 조기파기는 운영자가 대상을 지정해 "지금
      // 파기하라"고 명시적으로 판단한 행위라 유효기간보다 그 의사를 우선한다.
      // ※ 이 메서드 곳곳의 "조기파기와 동일 집합"(H-1) 불변식과 충돌하지 않는다. 그쪽은 **무엇을
      //   지우는가**(PII 5종·환불 진행중 제외)의 동형성이고, 이 가드는 **언제 지우는가**의 축이다.
      //   "동일 집합"을 근거로 이 가드를 조기파기에 이식하지 말 것.
      // 구현 주의 3가지:
      //  · 바깥 괄호는 필수다. TypeORM 0.3.x 는 raw string 조건을 자동으로 괄호치지 않으므로
      //    (isolateWhereStatements 미설정) 괄호를 지우면 AND/OR 우선순위로 정책이 뒤집힌다.
      //  · :now 는 위 파기 기준일 절과 **같은 파라미터**다. 파라미터 맵은 하나로 병합되고 나중
      //    바인딩이 이기므로, 여기서 다른 값을 넘기면 배치 전체의 커트오프 날짜가 함께 밀린다.
      //  · DATE(expireAt) < DATE(:now) 는 expireAt < DATE(:now) 와 동치다(우변이 자정이라 절삭
      //    비교와 결과가 같다). 후자가 sargable 이지만 선두 절이 이미 함수 적용이라 지금은 이득이
      //    없어 스타일 일관성을 택했다. 선두 절을 sargable 로 정리할 때 함께 바꾸면 된다.
      //
      // [성능 — 지금은 무해하나 장기 관찰 대상 (리뷰 MEDIUM)]
      //   보류된 행은 파기될 때까지 매 회차 후보군에 남는다. 유효기간 5년 상품이면 최대 5년간
      //   누적되므로 스캔 행 수가 단조 증가한다.
      //   ⚠️ orderDelivery.expireAt 에 인덱스를 추가해도 이 절은 그 인덱스를 타지 못한다. 이유는
      //   선두 절 때문이 아니라(그건 조인된 다른 테이블의 컬럼이라 이 테이블 접근 경로를 막지
      //   않는다) 이 절 자체의 구조 때문이다:
      //     · 3항 OR 이고, 가운데 항이 DATE(expireAt) 로 함수 래핑돼 non-sargable 이며,
      //       세 번째 항은 아예 다른 컬럼(deletedAt)이라 index_merge 로도 묶이지 않는다.
      //     · 게다가 이 절은 대상을 **넓히는** 필터라(대부분 행이 통과) 애초에 구동 접근 경로가
      //       될 수 없다.
      //   실제로 대상을 좁히는 절은 선두의 DATE_ADD(DATE(sendRequestAt), INTERVAL N DAY) 인데,
      //   이건 **두 컬럼을 조합**하므로 생성 컬럼(generated column) 없이는 함수 인덱스조차 못
      //   만든다 — (a) 방향이 단순 작업이 아닌 진짜 이유가 여기다.
      //   (이 레포는 스키마를 레포 밖 수기 SQL 로 관리해 인덱스 유무를 코드로 확인할 수 없다.
      //    실제 계획은 EXPLAIN 으로 확인할 것.)
      //   실제 부담은 접근 경로가 아니라 후보군 행 수이므로, 대응이 필요해지면
      //   (a) 두 날짜 절을 sargable 형태로 재작성해 인덱스를 태우거나
      //   (b) 보류 사유가 사라진 행만 남기도록 후보군 산정을 바꾸는 방향이다.
      //   (이미 파기된 행은 위 PII 5종 미파기 절이 걸러내므로 누적 대상이 아니다.)
      .andWhere(
        `(orderDelivery.expireAt IS NULL
          OR DATE(orderDelivery.expireAt) < DATE(:now)
          OR orderDelivery.deletedAt IS NOT NULL)`,
        { now },
      )
      .getMany();

    const destroyIdList = orderDeliveryList.map((od) => od.id);

    if (destroyIdList.length > 0) {
      // PII 5종 파기 — 조기파기(executeRequest)와 동일 집합으로 통일(H-1). 운영 정책: 환불 계좌
      // (bankAccount/bankAccountOwner)도 조기파기가 이미 파기하므로 정기파기 범위도 이를 따른다.
      //
      // destroyedAt 은 "언제 지웠나"의 **실적 기록**이다. 이게 없던 시절에는 화면이
      // `발송요청일 + 파기일수` 로 파기일을 역산했는데, 유효기간 가드로 규칙이 바뀌자 옛 규칙으로
      // 이미 파기된 행에 수년 뒤 날짜가 인쇄됐다(재리뷰 H-1). 규칙 변경에 흔들리지 않으려면
      // 추론이 아니라 기록이어야 하므로 파기하는 그 자리에서 남긴다.
      //
      // ⚠️ 이 UPDATE 의 대상 조건(위 WHERE)은 "PII 5종 중 **하나라도** 미파기"다. 즉 이미 한 번
      //    파기된 행도 다시 집힐 수 있고, 그때 destroyedAt 을 어떻게 할지는 **재수집 사유에 따라
      //    답이 갈린다**. 그래서 각인을 이 payload 에서 빼고 아래에서 사유별로 나눠 찍는다.
      await this.orderDeliveryRepository.update(
        { id: In(destroyIdList) },
        {
          deliveryTarget: destroyValue,
          originalDeliveryTarget: destroyValue,
          emailReceiverPhone: destroyValue,
          bankAccount: destroyValue,
          bankAccountOwner: destroyValue,
        },
      );

      // ── 파기 시각 각인 ────────────────────────────────────────────────────────
      // 재수집된 행은 두 종류이고, 각인 여부가 반대다.
      //
      //  (가) **부분 파기 재수집** — 이전 회차에 일부 컬럼만 '-' 가 되고 나머지가 남은 행.
      //       기존 값 **유지**.
      //       ⚠️ 다만 여기서 말하는 '일부'는 isDeliveryDestroyed 가 보는 2축(deliveryTarget /
      //          emailReceiverPhone) **밖의** 컬럼일 때만이다. 즉 bankAccount ·
      //          bankAccountOwner · originalDeliveryTarget 이 남아 있던 경우다. 그 셋이
      //          늦게 정리되는 것은 파기일을 바꾸지 않는다.
      //       ⚠️ emailReceiverPhone 이 남아 있던 행은 **(나)로 분류된다** — 부활한 적이 없어도.
      //          술어가 2축이라 그 행은 "지금 파기돼 있지 않음"이 되기 때문이다. 아래 (나) 참조.
      //       (초기 주석은 "판정 술어는 deliveryTarget 단일" 이라고 적고, 술어가 5종으로 바뀌면
      //        이 분기를 뒤집으라는 재검토 조건을 달아 두었다. 술어는 그 뒤 2축으로 넓어졌으므로
      //        조건이 일부 충족된 상태다 — 리뷰 4차 M-1. 5종 전부로 넓히는 정책이 되면 그때는
      //        (가)도 '완료 시점 갱신'으로 뒤집어야 한다.)
      //
      //  (나) **재파기 시 시각 갱신 대상** — 마스킹 이전 스냅샷에서 isDeliveryDestroyed 가
      //       false 인데 destroyedAt 이 이미 있던 행. 두 경로가 섞여 있고 **데이터만으로는
      //       구분할 수 없다**:
      //         · 파기 후 CS 수신정보 변경으로 수신처가 다시 채워진 행(사후 CS 대응을 위해
      //           **의도적으로 허용**된 경로. customer.service.service.ts 참조)
      //         · PII 5종 확대 이전에 emailReceiverPhone 이 마스킹되지 않은 레거시 행
      //           (되살아난 적 없음. migration §4-8 로 계량하며 2026-07-31 운영 실측은 합집합 0건
      //            이다 — 레거시 단독 부존재의 근거는 아니다. 그 쿼리는 둘을 구분하지 못한다.)
      //       ⚠️ 위 둘 중 **destroyedAt 이 아예 없는** 레거시 행은 여기가 아니라 firstDestroyIds
      //          로 간다. 그러면 오래 전 부분 파기된 행에 오늘 날짜가 BATCH(=실측)로 각인된다.
      //          현재 그런 행은 실측 0건이지만 구조적으로 열려 있는 경로이므로 적어 둔다.
      //       어느 쪽이든 **그 컬럼의 PII 는 지금 이 회차 직전까지 살아 있었다.** 옛 날짜를
      //       유지하면 "그때 이미 지웠다"는 거짓 증명이 되므로 새 시각으로 **갱신**한다.
      //       (갱신 전 값은 아래 로그에 남긴다 — 덮어쓰면 복구할 수 없으므로 감사 흔적이 필요하다.)
      //
      // 두 경우를 SQL 한 줄로 가를 수 없다. 위 마스킹 UPDATE 가 이미 돌아서 지금 DB 의
      // deliveryTarget 은 전부 '-' 이기 때문이다. 판정 근거는 **마스킹 이전 상태**이므로,
      // select 결과(orderDeliveryList)를 쓴다 — 이 목록은 UPDATE 전에 읽은 스냅샷이다.
      // 두 축(각인 유무 × 현재 파기 여부)으로 분류한다. 한 축만 보면 4사분면 중 하나가
      // 잘못 처리된다 — 특히 (각인 없음 + 이미 파기됨)을 '신규 각인'으로 넣으면 **파기 시점을
      // 모르는 행에 오늘 날짜를 실측으로 박제**하게 된다(리뷰 HIGH-2). 그 행의 PII 는 이전
      // 회차에 이미 사라졌으므로 오늘은 사실이 아니고, 한 번 찍히면 되돌릴 수 없다.
      // 이름을 '부활'로 두지 않는다 — 부활한 적 없는 레거시 부분마스킹 행도 여기 들어오므로
      // (위 (나) 참조), '부활'이라 부르면 로그가 없는 CS 오남용을 있다고 보고하게 된다.
      //
      // ★ 한 번만 필터하고 두 번 map 한다. 같은 술어를 두 벌 쓰면 (a) 한쪽만 고쳤을 때 각인
      //   대상과 감사 로그가 조용히 어긋나고(잡을 테스트가 없다), (b) 이 블록이 @Transactional
      //   안이라 로그 생성이 크리티컬 패스에 있다 — 불필요한 순회를 늘릴 이유가 없다.
      const restampRows = orderDeliveryList.filter((od) => od.destroyedAt !== null && !isDeliveryDestroyed(od));
      const restampIds = restampRows.map((od) => od.id);
      // 덮어쓰기 전 값 — 갱신하면 복구 불가라 감사 흔적으로 남긴다(아래 warn 로그).
      // toISOString 을 optional call(?.) 로 부른다. destroyedAt 은 Date 로 매핑되지만, 로그 한 줄
      // 때문에 트랜잭션 전체(그 회차 정기파기)가 롤백되는 것은 어떤 경우에도 이득이 아니다.
      const restampPrevious = restampRows.map(
        (od) => `${od.id}:${od.destroyedAt?.toISOString?.() ?? 'null'}/${od.destroyedAtSource ?? 'null'}`,
      );
      const firstDestroyIds = orderDeliveryList
        .filter((od) => od.destroyedAt === null && !isDeliveryDestroyed(od))
        .map((od) => od.id);
      // (각인 없음 + 이미 파기됨) — 시각을 알 수 없으므로 **각인하지 않는다**. 읽기측이 null 로
      // 답하고(effective.destroy.date.ts 분기 ③), 백필 §4-1 이 이 잔량을 센다.
      const unknownDestroyedAtIds = orderDeliveryList
        .filter((od) => od.destroyedAt === null && isDeliveryDestroyed(od))
        .map((od) => od.id);
      const stampIdList = [...firstDestroyIds, ...restampIds];

      if (stampIdList.length > 0) {
        // UpdateQueryBuilder 는 soft-delete 필터를 자동 부착하지 않으므로(TypeORM 은 select 에만
        // 부착한다), 위 select 가 withDeleted() 로 집어온 soft-delete 행도 그대로 갱신된다.
        await this.orderDeliveryRepository
          .createQueryBuilder()
          .update(OrderDeliveryEntity)
          // destroyedAtSource 를 함께 쓴다 — 이 값이 없으면 나중에 이 날짜가 실측인지
          // 백필 추정인지 판별할 수 없다(날짜만으로는 구분 불가).
          .set({ destroyedAt: now, destroyedAtSource: DESTROYED_AT_SOURCE.BATCH })
          .where('id IN (:...ids)', { ids: stampIdList })
          .execute();
      }

      // 관측 — 이 배치는 지금껏 처리 건수를 전혀 남기지 않았다. 파기일은 대외 증빙에 쓰이므로
      // "몇 건을 어떤 사유로 각인했는지"가 사후 감사의 유일한 단서다.
      // Set 으로 판정한다 — filter+includes 는 O(n²) 이고, 이 배치의 후보군은 유효기간 가드
      // 때문에 최대 5년치가 누적되어 단조 증가한다(위 성능 주석 참조). 로그 한 줄 때문에
      // 대량 회차에서 이중 루프를 돌 이유가 없다.
      const stampIdSet = new Set(stampIdList);
      // ⚠️ keptCount 는 '각인하지 않은 전부'라 두 종류가 섞인다 — 최초일을 **유지**하는 행(가)과
      //    애초에 최초일이 **없는** 행(unknownDestroyedAtIds). 후자를 '유지'로 뭉뚱그리면 아래
      //    error 로그와 합계가 어긋나 보이므로 괄호로 분리해 적는다.
      const keptCount = destroyIdList.filter((id) => !stampIdSet.has(id)).length;
      this.logger.log(
        `[정기파기] 대상 ${destroyIdList.length}건 — 신규 각인 ${firstDestroyIds.length}건, ` +
          `파기일 갱신 ${restampIds.length}건, 각인 안 함 ${keptCount}건` +
          `(그중 시각 미상 ${unknownDestroyedAtIds.length}건, 나머지는 최초일 유지)`,
      );
      if (unknownDestroyedAtIds.length > 0) {
        // 정상 운영에서는 나오지 않아야 한다. 백필 누락이거나 배포 순서 사고다.
        this.logger.error(
          `[정기파기] 이미 파기됐으나 파기 시각을 알 수 없는 발송건 ${unknownDestroyedAtIds.length}건 — ` +
            `orderDeliveryIds=[${unknownDestroyedAtIds.slice(0, 50).join(', ')}]. ` +
            `오늘 날짜를 실측으로 박제하지 않고 비워 둔다(해당 주문의 파기일은 null 로 응답된다).`,
        );
      }
      if (restampIds.length > 0) {
        // ⚠️ 문구를 원인으로 단정하지 않는다. 두 원인이 섞여 있고 데이터로는 구분되지 않는다
        //    (위 (나) 참조) — "수신처가 재입력됐다"고 쓰면 부활한 적 없는 레거시 부분마스킹 행까지
        //    CS 오남용으로 보고되어, 운영이 존재하지 않는 사건을 추적하게 된다(리뷰 4차 M-1).
        //    구분이 필요하면 migration §4-8 로 레거시 모집단을 먼저 계량할 것.
        // 이전 값을 함께 남긴다 — 덮어쓰면 복구 경로가 없다.
        this.logger.warn(
          `[정기파기] 이미 파기 시각이 있으나 PII 가 남아 있어 파기일을 갱신함 ${restampIds.length}건 ` +
            `(원인: CS 수신정보 변경 후 재파기 또는 레거시 부분마스킹 — 데이터로 구분 불가). ` +
            `갱신 전 값 id:시각/출처=[${restampPrevious.slice(0, 50).join(', ')}]`,
        );
      }

      // order_history 의 PII 도 함께 파기. '수신정보 변경요청'/'폐기 후 신규 발송' 이력의
      // beforeChange/afterChange 에는 평문 수신처가 남아 CS 이력 API(execStatusList)로 노출되므로,
      // 조기파기(executeRequest)와 동일하게 PII type 만 마스킹한다. 상태 감사 이력(폐기/환불폐기/
      // 핀상태 변경 등)은 couponStatus 전이 기록이므로 보존(제외).
      await this.orderHistoryRepository
        .createQueryBuilder()
        .update(OrderHistoryEntity)
        .set({ beforeChange: destroyValue, afterChange: destroyValue })
        .where('orderDeliveryId IN (:...ids)', { ids: destroyIdList })
        .andWhere('type IN (:...piiTypes)', { piiTypes: [...PII_BEARING_HISTORY_TYPES] })
        .execute();
    }
  }

  async handleDeliveryEncourage(): Promise<void> {
    const orderDeliveryList = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .where(`orderDelivery.encourageAt >= :startOfDay AND orderDelivery.encourageAt < :endOfDay`, {
        startOfDay: new Date(new Date().setHours(0, 0, 0, 0) - 9 * 60 * 60 * 1000),
        endOfDay: new Date(new Date().setHours(24, 0, 0, 0) - 9 * 60 * 60 * 1000),
      })
      .andWhere('order.status = :status', { status: IOrderStatus.DELIVERY_COMPLETE })
      .andWhere('orderDelivery.couponStatus = :couponStatus', { couponStatus: OrderDeliveryCouponStatus.NOT_USED })
      .andWhere('orderDelivery.status IN (:...deliveryStatusList)', {
        deliveryStatusList: [IOrderDeliveryStatus.COMPLETE, IOrderDeliveryStatus.COMPLETE_SMS],
      })
      .andWhere('orderDelivery.expireAt IS NOT NULL')
      .andWhere('orderDelivery.encourageAt IS NOT NULL')
      .andWhere('orderDelivery.barCode IS NOT NULL')
      .getMany();

    for (const orderDelivery of orderDeliveryList) {
      const decryptedDeliveryTarget = this.decryptDeliveryTarget(orderDelivery);
      const title = '미사용 쿠폰에 대한 유효기간 안내';
      const encryptKey = this.cryptoCipher.encryptJson(
        {
          id: orderDelivery.id,
          transactionId: orderDelivery.transactionId,
        } as OrderEncryptKey,
        couponTokenExpiry(orderDelivery.expireAt),
      );

      // 1. 알림톡 발송
      if (orderDelivery.deliveryMethod === IOrderSendMethod.ALIM_TALK) {
        try {
          const encourageTemplateCode = this.configService.getOrThrow('ALIM_TALK_INFO_BANK_ENCOURAGE_TEMPLATE_CODE');
          const alimTalkText = AlimTalkEncourageTemplate(orderDelivery, encourageTemplateCode);

          await this.deliveryAlimTalk.send({
            to: decryptedDeliveryTarget,
            text: alimTalkText,
            encryptKey: encryptKey,
            templateCode: encourageTemplateCode,
            msgType: 'AT', // 독려문자는 이미지 없는 기본형(AT) 사용
          });

          this.logger.log(`독려 알림톡 발송 완료: orderDelivery ${orderDelivery.id}`);
        } catch (e) {
          this.logger.error(`독려 알림톡 발송 실패: orderDelivery ${orderDelivery.id}`, e);
        }
      }

      // 2. SMS 발송
      if (orderDelivery.deliveryMethod === IOrderSendMethod.MMS) {
        try {
          const smsText = smsEncourageTemplate(orderDelivery);
          await this.smsSend.send({
            msgType: 'S',
            to: decryptedDeliveryTarget,
            from: orderDelivery.orderProductMapping.fromPhoneNumber!,
            subject: title,
            text: smsText,
            filePath: [],
          });

          this.logger.log(`독려 SMS 발송 완료: orderDelivery ${orderDelivery.id}`);
        } catch (e) {
          this.logger.error(`독려 SMS 발송 실패: orderDelivery ${orderDelivery.id}`, e);
        }
      }

      // 3. 이메일 발송
      if (orderDelivery.deliveryMethod === IOrderSendMethod.EMAIL) {
        try {
          const emailText = EmailEncourageTemplate(orderDelivery);
          const fromEmail = orderDelivery.orderProductMapping.fromEmail;

          await this.mailSend.send({
            saveSentMail: 'N',
            bcc: undefined,
            cc: undefined,
            content: emailText,
            subject: title,
            to: decryptedDeliveryTarget,
            fromEmail: fromEmail,
          });

          this.logger.log(`독려 이메일 발송 완료: orderDelivery ${orderDelivery.id}`);
        } catch (e) {
          this.logger.error(`독려 이메일 발송 실패: orderDelivery ${orderDelivery.id}`, e);
        }
      }
    }
  }
}
