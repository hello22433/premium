import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Repository } from 'typeorm';
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
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
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
import { ResendDeductService } from '../../wallet/application/resend-deduct.service';
import { DataSource, IsNull } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';

import { DeliveryAlimTalk } from '../interface/delivery.alim.talk';
import { IOrderDeliveryStatus } from '../interface/order.delivery.status';
import { OrderDeliveryCouponStatus } from '../interface/order.delivery.coupon.status';
import { IMailSend } from '../../mail/interface/mail-send';
import { ISmsSend } from '../../sms/interface/sms.send';
import { IOrderSendMethod } from '../../order/interface/order.send.method';
import { IOrderStatus } from '../../order/interface/order.status';
import { IOrderType } from '../../order/interface/order.type';
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
import { SmsChoiceProductTemplate } from '../domain/sms.choice.product.template';
import { smsCouponInfoTemplate } from '../domain/sms.coupon.info.template';
import { smsSsgShortTemplate, smsSsgTemplate } from '../domain/sms.ssg.template';
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
    @InjectRepository(OrderDeliveryAttemptEntity)
    private readonly orderDeliveryAttemptRepository: Repository<OrderDeliveryAttemptEntity>,
    @InjectRepository(OrderPaymentRefundEventEntity)
    private readonly orderPaymentRefundEventRepository: Repository<OrderPaymentRefundEventEntity>,
    @InjectRepository(OrderPaymentAllocationEntity)
    private readonly orderPaymentAllocationRepository: Repository<OrderPaymentAllocationEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly orderFromService: OrderFromService,
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
    const encryptedValue = fieldName === 'emailReceiverPhone'
      ? orderDelivery.emailReceiverPhone
      : orderDelivery.deliveryTarget;

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
    this.logger.error(`발송 실패 odId=${odId} method=${method} ${extraStr} msg=${(err as Error)?.message ?? String(err)}`);
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
        if (isWalletManaged) {
          this.logger.warn(
            `[REFUND] claim 중복 — wallet path 멱등 재시도 진행. orderDelivery.id: ${orderDelivery.id}, message: ${error.message}`,
          );
          claimWasDuplicate = true;
        } else {
          this.logger.warn(
            `[REFUND] 환불 중복 차단 (정상, legacy) - orderDelivery.id: ${orderDelivery.id}, message: ${error.message}`,
          );
          return;
        }
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
        const outcome = await this.ssgRefundResolverService.resolveAndRefundIfNeeded({
          orderDeliveryId: orderDelivery.id,
          ssgEventId: orderDelivery.ssgEventId!,
          refundAmount: productPrice,
          orderId: order.id,
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
        throw new Error(
          `wallet-managed delivery ${orderDelivery.id} missing attempt — drift, aborting refund`,
        );
      }
      await this.refundPoolService.refund({
        orderId: order.id,
        eventType: OrderPaymentRefundEventType.FAIL_REFUND,
        targetDeliveryIds: [orderDelivery.id],
        idempotencyKeyPrefix: `fail_refund:${order.id}:${orderDelivery.id}:${activeAttempt.id}`,
      });
      this.logger.log(
        `[REFUND] wallet path complete - orderDelivery.id: ${orderDelivery.id}, attemptId: ${activeAttempt.id}`,
      );
    } else {
      if (shouldRestoreBalance) {
        await this.userManagementService.addBalance(userId, settlementPrice, `발송 실패 환불 (주문번호: ${order.id})`);
      } else {
        await this.userRepository
          .createQueryBuilder()
          .update()
          .set({ allSettleAmount: () => 'all_settle_amount - :amount' })
          .where('id = :id', { id: userId })
          .setParameters({ amount: settlementPrice })
          .execute();
      }
      this.logger.log(
        `[REFUND] legacy path complete - orderDelivery.id: ${orderDelivery.id}, amount: ${settlementPrice} (정가: ${productPrice})`,
      );
    }
  }

  /**
   * 비정상 종료로 남은 WAIT 행의 claimedAt 을 해제한다. main.ts 에서 listen() 전 1회 호출.
   */
  async releaseStaleBatchClaims(): Promise<number> {
    const result = await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({ claimedAt: null })
      .where('status = :status', { status: IOrderDeliveryStatus.WAIT })
      .andWhere('claimedAt IS NOT NULL')
      .execute();
    return result.affected ?? 0;
  }

  async issueAndSend() {
    // 다른 배치가 동시에 돌더라도 UPDATE는 DB에서 직렬화되므로
    // claimed_at IS NULL 조건에 걸린 행만 이 배치가 소유하게 된다.
    // claimedAt 값은 이번 배치의 식별자로도 사용해서 뒤의 SELECT가 우리 몫만 가져오도록 한다.
    const claimedAt = new Date();
    const claimResult = await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({ claimedAt })
      .where('status = :status', { status: IOrderDeliveryStatus.WAIT })
      .andWhere('sendRequestAt < :now', { now: claimedAt })
      .andWhere('claimedAt IS NULL')
      .execute();

    const claimedCount = claimResult.affected ?? 0;
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
      .andWhere('orderDelivery.claimedAt = :claimedAt', { claimedAt });

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

    // 청크 구성 (SSG는 Mutex로 보호되므로 동시 처리 가능)
    const chunks = this.createDeliveryChunks(uniqueDeliveryList, concurrency);

    this.logger.log(
      `[BATCH] Processing ${uniqueDeliveryList.length} deliveries in ${chunks.length} chunks (concurrency: ${concurrency})`,
    );

    // 청크 단위로 병렬 처리
    let processedCount = 0;
    for (const chunk of chunks) {
      const chunkResults = await Promise.all(
        chunk.map((orderDelivery) => this.processOneDeliveryForBatch(orderDelivery)),
      );
      allResults.push(...chunkResults.filter((r) => r !== null));
      processedCount += chunk.length;
      this.logger.log(`[BATCH] Processed ${processedCount}/${uniqueDeliveryList.length}`);
    }

    // 결과 집계
    const deliveryHistoryList = allResults.map((r) => r.deliveryHistory);
    const orderIdList = [...new Set(allResults.map((r) => r.orderId))];

    // 히스토리 및 주문 상태 일괄 업데이트
    if (deliveryHistoryList.length > 0) {
      await this.deliverySendHistoryRepository.insert(deliveryHistoryList);
    }
    if (orderIdList.length > 0) {
      await this.orderRepository.update({ id: In(orderIdList) }, { status: IOrderStatus.DELIVERY_COMPLETE });
    }

    // 선정산(PRE_PAYMENT) 고객사 주문 자동 정산완료 처리
    try {
      await this.autoSettlePrePaymentOrders(orderIdList);
    } catch (error) {
      this.logger.error(`[BATCH] Auto-settle pre-payment orders failed for orderIds=[${orderIdList}]: ${error}`);
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

    const settleCompleteIds = prePaymentOrders
      .filter((o) => o.isSettleBalance)
      .map((o) => o.id);

    const unsettledCount = prePaymentOrders.length - settleCompleteIds.length;

    if (settleCompleteIds.length > 0) {
      await this.orderRepository.update(
        { id: In(settleCompleteIds) },
        { settleStatus: SettleUserOrderDetailEnum.SETTLE_COMPLETE },
      );
      this.logger.log(`[BATCH] Auto-settled ${settleCompleteIds.length} pre-payment orders (balance-paid)`);
    }

    if (unsettledCount > 0) {
      this.logger.log(`[BATCH] Skipped auto-settle for ${unsettledCount} pre-payment orders (credit-excess, kept UNSETTLE_NORMAL)`);
    }
  }

  /**
   * 단일 배송건 처리 (배치용) - PIN 발급 + 발송 + DB 저장
   *
   * 예외 발생 시 status=WAIT 행의 claimedAt을 해제해 다음 cron에서 재시도되게 한다.
   * 해제 안 하면 row가 영구 stale claim 상태로 빠져 부팅 시 releaseStaleClaims만이
   * 풀 수 있는 사고가 된다. status가 이미 FAIL/COMPLETE면 건드리지 않음.
   */
  private async processOneDeliveryForBatch(
    orderDelivery: OrderDeliveryEntity,
  ): Promise<{ deliveryHistory: DeliverySendHistoryEntity; orderId: number } | null> {
    try {
      const result = await this.processOneDeliveryInternal(orderDelivery);
      return result;
    } catch (error) {
      this.logger.error(`[BATCH] Failed to process orderDelivery.id: ${orderDelivery.id}, error: ${error}`);
      try {
        await this.orderDeliveryRepository.update(
          { id: orderDelivery.id, status: IOrderDeliveryStatus.WAIT },
          { claimedAt: null },
        );
      } catch (resetError) {
        this.logger.error(
          `[BATCH] claimedAt reset 실패 - orderDelivery.id: ${orderDelivery.id}, error: ${resetError}`,
        );
      }
      return null;
    }
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
  ): Promise<{ deliveryHistory: DeliverySendHistoryEntity; orderId: number }> {
    const order = orderDelivery.orderProductMapping.order;
    const product = orderDelivery.orderProductMapping.product;
    const isChoiceCoupon = product.type === IProductType.CHOICE;
    const isEmailDelivery = orderDelivery.deliveryMethod === IOrderSendMethod.EMAIL;

    // B1/B3: 최초 발송 실패는 환불을 보류한다(구매/발송 미성립 → 복구 이벤트 미생성).
    // 진입 시점(발송 전) status 로 최초/재발송을 구분한다. 재발송이면 직전이 FAIL/FAIL_SMS.
    // SSG 보류 여부는 발송 후 SsgInsertState 에 달려 있어(issue() 후 전이) refund 지점에서
    // shouldHoldRefundForFail() 로 재평가한다 (여기선 최초 발송 여부만 snapshot).
    const isInitialSend = orderDelivery.status !== IOrderDeliveryStatus.FAIL
      && orderDelivery.status !== IOrderDeliveryStatus.FAIL_SMS;

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

        this.logger.log(`[BATCH] PIN 발급 성공 - orderDelivery.id: ${orderDelivery.id}, barCode: ${orderDelivery.barCode}`);
      } catch (error) {
        this.logger.error(`[BATCH] PIN 발급 실패 - orderDelivery.id: ${orderDelivery.id}, error: ${error}`);

        // B1/B3: 최초 발송 실패는 환불 보류. SSG 는 ATTEMPTED 만 환불, 재발송 실패는 환불.
        const shouldHold = isInitialSend && (await this.shouldHoldRefundForFail(orderDelivery, order));
        if (!shouldHold) {
          await this.refundForFail(orderDelivery);
        }

        this.markSendFail(orderDelivery, IOrderDeliveryStatus.FAIL);
        await this.orderDeliveryRepository.save(orderDelivery);

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
    const decryptedDeliveryTarget = this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.deliveryTarget) ?? orderDelivery.deliveryTarget;

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
        this.logger.log(`[BATCH] 이미지 재생성 - orderDelivery.id: ${orderDelivery.id}, imagePath: ${orderDelivery.imagePath}`);
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
    const memo = memoRaw && order.type !== IOrderType.SSG && deliveryMethod !== IOrderSendMethod.EMAIL
      ? applyReplaceCharacters(memoRaw, orderDelivery)
      : null;
    const tailRaw = orderDelivery.orderProductMapping.sendTailText;
    const tailText = tailRaw ? applyReplaceCharacters(tailRaw, orderDelivery) : null;

    const deliveryHistory = new DeliverySendHistoryEntity();
    deliveryHistory.context = '{}';
    deliveryHistory.isSuccess = true;
    deliveryHistory.target = decryptedDeliveryTarget;
    deliveryHistory.deliveryMethod = deliveryMethod;

    const encryptKey = this.cryptoCipher.encryptJson({
      id: orderDelivery.id,
      transactionId: orderDelivery.transactionId,
    } as OrderEncryptKey, couponTokenExpiry(orderDelivery.expireAt));

    // 6. 발송 채널별 처리
    if (deliveryMethod === IOrderSendMethod.ALIM_TALK) {
      await this.deliverySendService.sendAlimTalk(orderDelivery, decryptedDeliveryTarget, encryptKey, title, body, memo, tailText, filePathList, deliveryHistory);
    } else if (deliveryMethod === IOrderSendMethod.MMS) {
      await this.deliverySendService.sendSms(orderDelivery, decryptedDeliveryTarget, encryptKey, title, body, memo, tailText, filePathList, deliveryHistory);
    } else if (deliveryMethod === IOrderSendMethod.EMAIL) {
      const emailText = tailText ? `${body}\n\n${tailText}` : body;
      await this.deliverySendService.sendEmail(orderDelivery, decryptedDeliveryTarget, encryptKey, title, emailText, deliveryHistory);
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
    await this.orderDeliveryRepository.update(
      { id: orderDelivery.id },
      {
        status: orderDelivery.status,
        actualSendAt: orderDelivery.actualSendAt,
        failedAt: orderDelivery.failedAt,
      },
    );
    await this.orderDeliveryRepository.update(
      { id: orderDelivery.id },
      {
        imagePath: orderDelivery.imagePath,
        expireAt: orderDelivery.expireAt,
        encourageAt: orderDelivery.encourageAt,
      },
    );

    // 6. 발송 실패 시 환불 처리 (B1/B3: 최초 발송 실패는 보류, SSG 는 ATTEMPTED 만 환불, 재발송은 환불)
    if (orderDelivery.status === IOrderDeliveryStatus.FAIL) {
      const shouldHold = isInitialSend && (await this.shouldHoldRefundForFail(orderDelivery, order));
      if (!shouldHold) {
        await this.refundForFail(orderDelivery);
      }
    }

    // 7. DB 저장
    await this.orderDeliveryRepository.save(orderDelivery);

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
  ): Promise<IOrderDeliveryStatus.COMPLETE_SMS | unknown> {
    try {
      const smsText = this.buildSmsText(orderDelivery, encryptKey, body, memo, tailText);
      const fromPhoneNumber = orderDelivery.orderProductMapping.fromPhoneNumber!;
      await this.smsSend.send({
        msgType: 'M',
        to: decryptedDeliveryTarget,
        from: fromPhoneNumber,
        subject: title,
        text: smsText,
        filePath: filePathList,
      });
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
    const isSsgAlreadyComplete = order.type === IOrderType.SSG
      && orderDelivery.barCode
      && (orderDelivery.status === IOrderDeliveryStatus.COMPLETE
        || orderDelivery.status === IOrderDeliveryStatus.COMPLETE_SMS);
    const needsIssue = !orderDelivery.barCode || (order.type === IOrderType.SSG && !isSsgAlreadyComplete);
    if (needsIssue) {
      const hadNoBarCode = !orderDelivery.barCode;
      let ssgEvent: SsgEventEntity | null = null;
      let resendDeducted = false;
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
        const canDeductNewEvent = stateForResendDeduct === SsgInsertState.NONE
          || stateForResendDeduct === SsgInsertState.FAILED;
        // B3: SSG FAIL 재발송에서 새 행사 선차감이 적용되는 케이스를 공통 가드로 묶는다.
        // (세 신호 AND: SSG + FAIL + canDeductNewEvent)
        const isSsgFailResendDeduct = order.type === IOrderType.SSG
          && orderDelivery.status === IOrderDeliveryStatus.FAIL
          && canDeductNewEvent;

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
          const newEvent = await this.ssgEventService.selectEventForOrder(
            product.price,
            product.expireDay,
          );
          if (!newEvent) {
            this.logger.warn(
              `[RESEND] 잔액 충분한 SSG 행사 없음 - orderDelivery.id: ${orderDelivery.id}, price: ${product.price}`,
            );
            return false;
          }
          await this.ssgEventService.deductEventBalance(newEvent.id, product.price, order.id, false);
          ssgEvent = newEvent;
          resendDeducted = true;
        }

        await this.partnerCompanyExternService.issue(orderDelivery, ssgEvent);

        if (!orderDelivery.barCode) {
          this.logger.error(`[RESEND] PIN 재발급 실패 - orderDelivery.id: ${orderDelivery.id}`);
          if (resendDeducted && ssgEvent) {
            await this.refundResendDeduct(orderDelivery, ssgEvent.id, product.price, order.id);
            resendDeducted = false;
          }
          return false;
        }

        // 성공 시 ssgEventId 업데이트 (다른 행사로 변경된 경우)
        if (resendDeducted && ssgEvent) {
          orderDelivery.ssgEventId = ssgEvent.id;
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

        this.logger.log(`[RESEND] PIN 발급/확인 성공 - orderDelivery.id: ${orderDelivery.id}, barCode: ${orderDelivery.barCode}`);
      } catch (error) {
        this.logger.error(`[RESEND] PIN 발급/확인 실패 - orderDelivery.id: ${orderDelivery.id}, error: ${error}`);
        // issue() throw 시에도 선차감 환불 (shared resolver — state 기준 분기)
        if (resendDeducted && ssgEvent) {
          await this.refundResendDeduct(orderDelivery, ssgEvent.id, product.price, order.id);
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
   * 재발송 선차감 환불 (PIN 발급 실패 또는 issue() throw 시).
   * shared resolver 를 통해 state 기준으로 SSG 행사 잔액을 복구한다.
   */
  private async refundResendDeduct(
    orderDelivery: OrderDeliveryEntity,
    ssgEventId: number,
    refundAmount: number,
    orderId: number,
  ): Promise<void> {
    // resolver 는 throw 흡수 + outcome 반환. DEFERRED 시 ledger.ssg_balance_settled 가 false 로
    // 남거나 markSsgSettled 가 호출 안 됨 → 다음 재발송 가드에서 차단.
    const outcome = await this.ssgRefundResolverService.resolveAndRefundIfNeeded({
      orderDeliveryId: orderDelivery.id,
      ssgEventId,
      refundAmount,
      orderId,
    });
    if (outcome === SsgRefundOutcome.DEFERRED) {
      this.logger.error(
        `[RESEND] 선차감 환불 DEFERRED — 운영 점검 필요. orderDelivery.id: ${orderDelivery.id}`,
      );
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
    try {
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
          this.logger.log(
            `[RESEND] SSG chargeBack skip — state=CONFIRMED. orderDelivery.id=${orderDelivery.id}`,
          );
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
    const isWalletManaged = await this.walletManagedPredicate.isWalletManaged(
      order.id,
      this.orderRepository.manager,
    );
    if (isWalletManaged) {
      await this.applyWalletReverseRefundForResendOnManager(orderDelivery, this.orderRepository.manager);
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

    const isUnselectedChoiceCoupon = orderDelivery.orderProductMapping.product.type === IProductType.CHOICE && !orderDelivery.choiceSelectProductId;
    if (!orderDelivery.barCode && !isUnselectedChoiceCoupon) {
      throw new Error('쿠폰이 발급되지 않은 건은 MMS 재발송이 불가능합니다.');
    }

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
    const phoneNumber = orderDelivery.deliveryMethod === IOrderSendMethod.EMAIL && orderDelivery.emailReceiverPhone
      ? this.decryptDeliveryTarget(orderDelivery, 'emailReceiverPhone')
      : this.decryptDeliveryTarget(orderDelivery);

    // 텍스트 빌드
    const title = orderDelivery.orderProductMapping.sendTitle ?? '';
    const body = applyReplaceCharacters(orderDelivery.orderProductMapping.sendContent ?? '', orderDelivery);
    const memoSourceProduct = orderDelivery.choiceSelectProduct ?? orderDelivery.orderProductMapping.product;
    const memoRaw = memoSourceProduct.memo;
    const memo = memoRaw && orderDelivery.orderProductMapping.order.type !== IOrderType.SSG
      ? applyReplaceCharacters(memoRaw, orderDelivery)
      : null;
    const tailRaw = orderDelivery.orderProductMapping.sendTailText;
    const tailText = tailRaw ? applyReplaceCharacters(tailRaw, orderDelivery) : null;

    const encryptKey = this.cryptoCipher.encryptJson({
      id: orderDelivery.id,
      transactionId: orderDelivery.transactionId,
    } as OrderEncryptKey, couponTokenExpiry(orderDelivery.expireAt));

    const smsText = this.buildSmsText(orderDelivery, encryptKey, body, memo, tailText);

    const filePathList: string[] = [];
    if (orderDelivery.imagePath) {
      filePathList.push(orderDelivery.imagePath);
    }

    const fromPhoneNumber =
      orderDelivery.orderProductMapping.fromPhoneNumber ||
      (await this.orderFromService.resolveSendDefaultPhone(getBillingUserId(orderDelivery.orderProductMapping.order)));
    await this.smsSend.send({
      msgType: 'M',
      to: phoneNumber,
      from: fromPhoneNumber,
      subject: title,
      text: smsText,
      filePath: filePathList,
    });
  }

  async csResendAsAlimTalk(orderDeliveryId: number): Promise<IOrderDeliveryStatus.COMPLETE | IOrderDeliveryStatus.COMPLETE_SMS> {
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

    const isUnselectedChoiceCoupon = orderDelivery.orderProductMapping.product.type === IProductType.CHOICE && !orderDelivery.choiceSelectProductId;
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
    const phoneNumber = orderDelivery.deliveryMethod === IOrderSendMethod.EMAIL && orderDelivery.emailReceiverPhone
      ? this.decryptDeliveryTarget(orderDelivery, 'emailReceiverPhone')
      : this.decryptDeliveryTarget(orderDelivery);

    const alimTalk = AlimTalkTemplate(orderDelivery);

    const encryptKey = this.cryptoCipher.encryptJson({
      id: orderDelivery.id,
      transactionId: orderDelivery.transactionId,
    } as OrderEncryptKey, couponTokenExpiry(orderDelivery.expireAt));

    // 알림톡 시도
    let alimTalkSucceeded = false;
    try {
      const { report } = await this.deliveryAlimTalk.send({
        to: phoneNumber,
        text: alimTalk,
        encryptKey: encryptKey,
      });
      alimTalkSucceeded = report.code === 'A000';
    } catch (e) {
      this.logger.warn(`[CS_RESEND] 알림톡 발송 실패, MMS 폴백 시도 - orderDelivery.id: ${orderDelivery.id}, error: ${e}`);
    }

    if (alimTalkSucceeded) {
      return IOrderDeliveryStatus.COMPLETE;
    }

    // 폴백: MMS 발송
    const title = orderDelivery.orderProductMapping.sendTitle ?? '';
    const body = applyReplaceCharacters(orderDelivery.orderProductMapping.sendContent ?? '', orderDelivery);
    const memoSourceProduct = orderDelivery.choiceSelectProduct ?? orderDelivery.orderProductMapping.product;
    const memoRaw = memoSourceProduct.memo;
    const memo = memoRaw && orderDelivery.orderProductMapping.order.type !== IOrderType.SSG
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

    await this.smsSend.send({
      msgType: 'M',
      to: phoneNumber,
      from: fromPhoneNumber,
      subject: title,
      text: smsText,
      filePath: filePathList,
    });

    return IOrderDeliveryStatus.COMPLETE_SMS;
  }

  async csResendAsSms(orderDeliveryId: number): Promise<void> {
    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .leftJoinAndSelect('orderProductMapping.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .leftJoinAndSelect('choiceSelectProduct.brand', 'choiceBrand')
      .withDeleted()
      .where('orderDelivery.id = :id', { id: orderDeliveryId })
      .getOne();

    if (!orderDelivery) {
      throw new Error('발송 데이터가 존재하지 않습니다.');
    }

    this.assertChoiceProductNotDeletedForCsResend(orderDelivery);

    const isUnselectedChoiceCoupon = orderDelivery.orderProductMapping.product.type === IProductType.CHOICE && !orderDelivery.choiceSelectProductId;
    if (!orderDelivery.barCode && !isUnselectedChoiceCoupon) {
      throw new Error('쿠폰이 발급되지 않은 건은 SMS 재발송이 불가능합니다.');
    }

    // 수신 전화번호 결정
    const phoneNumber = orderDelivery.deliveryMethod === IOrderSendMethod.EMAIL && orderDelivery.emailReceiverPhone
      ? this.decryptDeliveryTarget(orderDelivery, 'emailReceiverPhone')
      : this.decryptDeliveryTarget(orderDelivery);

    // SMS 텍스트
    const orderType = orderDelivery.orderProductMapping.order.type;
    let text: string;
    if (isUnselectedChoiceCoupon) {
      // 초이스쿠폰 미선택: 상품선택 링크 재발송
      const encryptKey = this.cryptoCipher.encryptJson({
        id: orderDelivery.id,
        transactionId: orderDelivery.transactionId,
      } as OrderEncryptKey, couponTokenExpiry(orderDelivery.expireAt));
      const choiceUrl = this.configService.getOrThrow('SMS_CHOICE_URL');
      text = `초이스 쿠폰 받기 링크 : ${choiceUrl}/${encryptKey}`;
    } else if (orderType === IOrderType.SSG) {
      text = smsSsgShortTemplate(orderDelivery);
    } else {
      const displayProduct = orderDelivery.choiceSelectProduct ?? orderDelivery.orderProductMapping.product;
      const productName = displayProduct.name;
      const brandName = (orderDelivery.choiceSelectProduct?.brand ?? orderDelivery.orderProductMapping.product.brand)?.nameKorean ?? '';
      const expireDate = orderDelivery.expireAt ? format(orderDelivery.expireAt, 'yy/MM/dd') : '';
      text = `[${productName}]\n교환처:${brandName}\n쿠폰번호:${orderDelivery.barCode}\n${expireDate}까지`;
    }

    const textBytes = Buffer.byteLength(text, 'utf8');
    const msgType: 'S' | 'L' = textBytes <= 90 ? 'S' : 'L';
    const fromPhoneNumber =
      orderDelivery.orderProductMapping.fromPhoneNumber ||
      (await this.orderFromService.resolveSendDefaultPhone(getBillingUserId(orderDelivery.orderProductMapping.order)));

    await this.smsSend.send({
      msgType,
      to: phoneNumber,
      from: fromPhoneNumber,
      subject: msgType === 'L' ? ' ' : '',
      text,
      filePath: [],
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
      emailSendHistory.email = decryptedEmail;
      emailSendHistory.type = EmailType.COUPON;
      emailSendHistory.code = generateRandomCode();
      emailSendHistory.expireAt = addDays(new Date(), EmailCertifyExpireDay);
      await this.emailSendHistoryRepository.save(emailSendHistory);
    }

    const encryptKeyEmail = this.cryptoCipher.encryptJson({
      id: orderDelivery.id,
      transactionId: orderDelivery.transactionId,
      emailHistoryId: emailSendHistory.id,
    } as OrderEncryptKey, couponTokenExpiry(orderDelivery.expireAt));

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

  async oneSend(orderDelivery: OrderDeliveryEntity, isSave: boolean = true, testOrderDeliveryId?: number): Promise<boolean> {
    const order = orderDelivery.orderProductMapping.order;
    // 재발송인 경우 chargeBack 후 발송 실패 시 재환불이 필요한지 판단하기 위해 이전 상태 저장 (FAIL_SMS 포함)
    const wasFailBefore = !testOrderDeliveryId
      && (orderDelivery.status === IOrderDeliveryStatus.FAIL
        || orderDelivery.status === IOrderDeliveryStatus.FAIL_SMS);

    // B1/B3: 실패 재발송 — 보류(환불 미생성)/환불됨 분기. snapshot 은 reissue 호출 *전* 에 잡는다
    // (reissue 내부 reverseRefundForResend 가 ledger 를 release 해 exists() 가 뒤집히기 때문).
    // refunded reverse 보강은 비-SSG 만(SSG refunded 는 reissue 내부에서 처리), held-slot 발급은 SSG 포함 wallet 전체.
    const isWalletManaged = wasFailBefore
      ? await this.walletManagedPredicate.isWalletManaged(order.id)
      : false;
    const refundLedgerBeforeReissue = wasFailBefore
      ? await this.refundLedgerService.exists(orderDelivery.id)
      : false;

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
          await this.orderDeliveryRepository.save(orderDelivery);
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
        orderDelivery.encourageAt = subDays(
          orderDelivery.expireAt,
          encourageDay,
        );
      }
    }

    const filePathList = [];
    if (orderDelivery.imagePath) {
      filePathList.push(orderDelivery.imagePath);
    }

    const deliveryMethod = orderDelivery.deliveryMethod;

    const body = applyReplaceCharacters(orderDelivery.orderProductMapping.sendContent ?? '', orderDelivery);
    const memoSourceProduct = orderDelivery.choiceSelectProduct ?? orderDelivery.orderProductMapping.product;
    const memoRaw = memoSourceProduct.memo;
    const memo = memoRaw && deliveryMethod !== IOrderSendMethod.EMAIL && orderDelivery.orderProductMapping.order.type !== IOrderType.SSG
      ? applyReplaceCharacters(memoRaw, orderDelivery)
      : null;
    const tailRaw = orderDelivery.orderProductMapping.sendTailText;
    const tailText = tailRaw ? applyReplaceCharacters(tailRaw, orderDelivery) : null;

    const deliveryHistory = new DeliverySendHistoryEntity();
    deliveryHistory.context = '{}';
    deliveryHistory.isSuccess = true;
    deliveryHistory.target = decryptedDeliveryTarget;
    deliveryHistory.deliveryMethod = deliveryMethod;

    // 테스트 발송인 경우 testOrderDeliveryId와 isTest 플래그 사용
    const encryptKey = this.cryptoCipher.encryptJson({
      id: testOrderDeliveryId ?? orderDelivery.id,
      transactionId: orderDelivery.transactionId,
      isTest: !!testOrderDeliveryId,
    } as OrderEncryptKey, couponTokenExpiry(orderDelivery.expireAt));

    // 알림톡 발송
    if (deliveryMethod === IOrderSendMethod.ALIM_TALK) {
      try {
        const alimTalk = AlimTalkTemplate(orderDelivery);
        const { responseData, report } = await this.deliveryAlimTalk.send({
          to: decryptedDeliveryTarget,
          text: alimTalk,
          encryptKey: encryptKey,
        });

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
        const resultSms = await this.handleAlimTalkFail(orderDelivery, title, body, memo, tailText, filePathList, decryptedDeliveryTarget, encryptKey);

        if (resultSms === IOrderDeliveryStatus.COMPLETE_SMS) {
          // 알림톡 실패 → SMS 폴백 성공 (정상 흐름이므로 에러 로그 남기지 않음)
          deliveryHistory.isSuccess = true;
          this.markSendSuccess(orderDelivery, IOrderDeliveryStatus.COMPLETE_SMS);
        } else {
          deliveryHistory.context += ` / smsResult=${resultSms}`;
          this.logSendFail(orderDelivery.id, 'ALIM_TALK', { target: decryptedDeliveryTarget, test: !!testOrderDeliveryId, alimTalkErr: errMsg, smsResult: resultSms }, e);
          this.markSendFail(orderDelivery, IOrderDeliveryStatus.FAIL);
        }
      }
    }

    // SMS 발송
    if (deliveryMethod === IOrderSendMethod.MMS) {
      const smsText = this.buildSmsText(orderDelivery, encryptKey, body, memo, tailText);
      const fromPhoneNumber = orderDelivery.orderProductMapping.fromPhoneNumber!;

      try {
        await this.smsSend.send({
          msgType: 'M',
          to: decryptedDeliveryTarget,
          from: fromPhoneNumber,
          subject: title,
          text: smsText,
          filePath: filePathList,
        });
        this.markSendSuccess(orderDelivery, IOrderDeliveryStatus.COMPLETE);
        deliveryHistory.context = smsText;
      } catch (e) {
        this.markSendFail(orderDelivery, IOrderDeliveryStatus.FAIL);
        this.logSendFail(orderDelivery.id, 'MMS', { target: decryptedDeliveryTarget, from: fromPhoneNumber, test: !!testOrderDeliveryId }, e);
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
        const decryptedEmailReceiverPhone = this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.emailReceiverPhone) ?? orderDelivery.emailReceiverPhone;
        const fromPhoneNumber = orderDelivery.orderProductMapping.fromPhoneNumber!;

        try {
          await this.smsSend.send({
            msgType: 'M',
            to: decryptedEmailReceiverPhone,
            from: fromPhoneNumber,
            subject: title,
            text: emailText,
            filePath: filePathList,
          });
          this.markSendSuccess(orderDelivery, IOrderDeliveryStatus.COMPLETE);
          deliveryHistory.context = emailText;
          deliveryHistory.target = decryptedEmailReceiverPhone;
        } catch (e) {
          this.markSendFail(orderDelivery, IOrderDeliveryStatus.FAIL);
          this.logSendFail(orderDelivery.id, 'EMAIL_SMS_RESEND', { target: decryptedEmailReceiverPhone, from: fromPhoneNumber, test: !!testOrderDeliveryId }, e);
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
          emailSendHistory.email = decryptedDeliveryTarget;
          emailSendHistory.type = EmailType.COUPON;
          emailSendHistory.code = generateRandomCode();
          emailSendHistory.expireAt = addDays(new Date(), EmailCertifyExpireDay);
          await this.emailSendHistoryRepository.save(emailSendHistory);
        }

        // 테스트 발송인 경우 testOrderDeliveryId 사용
        const encryptKeyEmail = this.cryptoCipher.encryptJson({
          id: testOrderDeliveryId ?? orderDelivery.id,
          transactionId: orderDelivery.transactionId,
          emailHistoryId: emailSendHistory.id,
          isTest: !!testOrderDeliveryId,
        } as OrderEncryptKey, couponTokenExpiry(orderDelivery.expireAt));

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
          this.logSendFail(orderDelivery.id, 'EMAIL', { target: decryptedDeliveryTarget, fromEmail: fromEmail, test: !!testOrderDeliveryId }, e);
          deliveryHistory.context = (e as Error)?.message ?? String(e);
          deliveryHistory.isSuccess = false;
        }
      }
    }

    // 재발송 시 chargeBack 후 발송이 다시 실패한 경우: 환불 복구 (FAIL_SMS 포함)
    if (wasFailBefore
      && (orderDelivery.status === IOrderDeliveryStatus.FAIL
        || orderDelivery.status === IOrderDeliveryStatus.FAIL_SMS)) {
      await this.refundForFail(orderDelivery);
    }

    if (isSave) {
      await this.orderDeliveryRepository.save(orderDelivery);
    }

    // 테스트 발송은 발송실패내역(delivery_send_history)에 기록하지 않는다.
    // 실패 원인은 위 catch 블록의 logger.error 로그로만 추적한다.
    if (!testOrderDeliveryId) {
      await this.deliverySendHistoryRepository.save(deliveryHistory);
    }

    return orderDelivery.status === IOrderDeliveryStatus.COMPLETE || orderDelivery.status === IOrderDeliveryStatus.COMPLETE_SMS;
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
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .where(
        `DATE_ADD(orderProductMapping.sendRequestAt, INTERVAL orderProductMapping.requestToDestroyPersonalInfoDay DAY) <= :now`,
        { now },
      )
      .andWhere('order.status = :status', { status: IOrderStatus.DELIVERY_COMPLETE })
      .andWhere(
        '(orderDelivery.deliveryTarget != :destroyValue OR orderDelivery.originalDeliveryTarget != :destroyValue)',
        { destroyValue },
      )
      .getMany();

    const destroyIdList = orderDeliveryList.map((od) => od.id);

    if (destroyIdList.length > 0) {
      await this.orderDeliveryRepository.update(
        { id: In(destroyIdList) },
        { deliveryTarget: destroyValue, originalDeliveryTarget: destroyValue },
      );
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
      const encryptKey = this.cryptoCipher.encryptJson({
        id: orderDelivery.id,
        transactionId: orderDelivery.transactionId,
      } as OrderEncryptKey, couponTokenExpiry(orderDelivery.expireAt));

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

  /**
   * 배송 목록을 청크로 분할
   * SSG는 Mutex로 보호되므로 별도 분리 없이 일반 청크 처리
   */
  private createDeliveryChunks(
    deliveryList: OrderDeliveryEntity[],
    chunkSize: number,
  ): OrderDeliveryEntity[][] {
    const chunks: OrderDeliveryEntity[][] = [];

    for (let i = 0; i < deliveryList.length; i += chunkSize) {
      chunks.push(deliveryList.slice(i, i + chunkSize));
    }

    return chunks;
  }
}
