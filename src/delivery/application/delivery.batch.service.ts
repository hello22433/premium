import { Inject, Injectable, Logger } from '@nestjs/common';
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
import { resolveExpireDays } from '../../common/utils/expire.util';
import { OrderEntity } from '../../entity/order.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { OrderRealProductEntity } from '../../entity/order.real.product.entity';
import { OrderRealProductMappingEntity } from '../../entity/order.real.product.mapping.entity';
import { DeliverySendHistoryEntity } from '../../entity/delivery.send.history.entity';
import { EmailSendHistoryEntity } from '../../entity/email.send.history.entity';
import { UserEntity } from '../../entity/user.entity';
import { SsgEventEntity } from '../../entity/ssg.event.entity';

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
import { OrderFeeCalculator, applyCardSurcharge } from '../../order/domain/order.fee.calculator';
import { getEffectiveFee, getEffectivePriceAdjustment } from '../../util/settle-fee.util';
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
import { EmailCertifyExpireDay, defaultFromPhoneNumber } from '../../const';

import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { OrderEncryptKey } from '../../order_receive/interface/order.encrypt.key';
import { generateRandomCode } from '../../user_find/domain/code.generate';
import { DeliveryTrackHttp } from '../infra/delivery.track.http';
import { DeliveryCreateCouponImage } from '../infra/delivery.create.coupon.image';

import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { SsgEventService } from '../../ssg_event/application/ssg.event.service';
import { UserManagementService } from '../../user_management/application/user.management.service';
import { DeliverySendService } from './delivery.send.service';

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
      return encryptedValue ?? '';
    }

    try {
      return this.cryptoCipher.decryptDeliveryTarget(encryptedValue);
    } catch (error) {
      this.logger.error(`Failed to decrypt ${fieldName} for orderDelivery ${orderDelivery.id}: ${error}`);
      return encryptedValue;
    }
  }

  /**
   * 발송 성공 시 actualSendAt 설정
   */
  private markSendSuccess(orderDelivery: OrderDeliveryEntity, status: IOrderDeliveryStatus): void {
    this.deliverySendService.markSendSuccess(orderDelivery, status);
  }

  /**
   * 발송 실패 시 failedAt 설정
   */
  private markSendFail(orderDelivery: OrderDeliveryEntity, status: IOrderDeliveryStatus): void {
    this.deliverySendService.markSendFail(orderDelivery, status);
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
   * 매핑의 할인/할증 + 카드할증을 적용한 정산단가 계산
   * fee/priceAdjustment가 미설정이면 정가 기준, 카드할증은 order에서 판단
   */
  private calculateSettlementPrice(
    mapping: OrderProductMappingEntity,
    cardSurchargeApplied: boolean,
    delivery?: OrderDeliveryEntity,
  ): number {
    let price = mapping.product.price;
    const fee = getEffectiveFee(delivery, mapping);
    const priceAdjustment = getEffectivePriceAdjustment(delivery, mapping);
    if (fee !== null && priceAdjustment) {
      price = OrderFeeCalculator({ fee, priceAdjustment, price });
    }
    return applyCardSurcharge(price, cardSurchargeApplied);
  }

  /**
   * 발송 실패 시 환불 처리 (SSG 이벤트 잔액 복원 + 사용자 잔액/정산 복원)
   * PIN 발급 실패, 메시지 발송 실패 등 delivery가 FAIL이 될 때 호출
   */
  private async refundForFail(orderDelivery: OrderDeliveryEntity): Promise<void> {
    const order = orderDelivery.orderProductMapping.order;
    const mapping = orderDelivery.orderProductMapping;
    const productPrice = mapping.product.price;
    const settlementPrice = this.calculateSettlementPrice(mapping, order.cardSurchargeApplied, orderDelivery);
    // 과금 대상 userId (대행주문인 경우 clientUserId, 아니면 userId)
    const userId = order.clientUserId ?? order.user!.id;

    try {
      // SSG 이벤트 잔액 복원은 쿠폰 액면가(productPrice) 기준
      if (order.type === IOrderType.SSG && orderDelivery.ssgEventId) {
        await this.ssgEventService.refundForDeliveryFail(orderDelivery.ssgEventId, order.id, productPrice);
      }

      // 사용자 잔액/정산 복원은 정산단가(settlementPrice) 기준
      if (order.isSettleBalance) {
        await this.userManagementService.addBalance(userId, settlementPrice, `발송 실패 환불 (주문번호: ${order.id})`);
      } else {
        const user = await this.userRepository.findOne({ where: { id: userId } });
        if (user) {
          user.allSettleAmount -= settlementPrice;
          await this.userRepository.save(user);
        }
      }

      this.logger.log(`[REFUND] 환불 완료 - orderDelivery.id: ${orderDelivery.id}, amount: ${settlementPrice} (정가: ${productPrice})`);
    } catch (error) {
      this.logger.error(`[REFUND] 환불 실패 - orderDelivery.id: ${orderDelivery.id}, error: ${error}`);
    }
  }

  /**
   * 비정상 종료로 claimed_at이 남아있는 WAIT 행을 해제한다.
   * 부팅 시 1회만 호출된다 (PM2 단일 인스턴스 전제).
   */
  async releaseStaleClaims(): Promise<number> {
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
   */
  private async processOneDeliveryForBatch(
    orderDelivery: OrderDeliveryEntity,
  ): Promise<{ deliveryHistory: DeliverySendHistoryEntity; orderId: number } | null> {
    try {
      const result = await this.processOneDeliveryInternal(orderDelivery);
      return result;
    } catch (error) {
      this.logger.error(`[BATCH] Failed to process orderDelivery.id: ${orderDelivery.id}, error: ${error}`);
      return null;
    }
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

        await this.refundForFail(orderDelivery);

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

    // 4. 발송 텍스트 준비
    const filePathList: string[] = [];
    if (orderDelivery.imagePath) {
      filePathList.push(orderDelivery.imagePath);
    }
    let text = orderDelivery.orderProductMapping.sendContent ?? '';

    if (
      orderDelivery.orderProductMapping.product.memo &&
      orderDelivery.orderProductMapping.order.type !== IOrderType.SSG &&
      orderDelivery.deliveryMethod !== IOrderSendMethod.EMAIL
    ) {
      text += `\n\n${orderDelivery.orderProductMapping.product.memo}`;
    }

    const sendTailText = orderDelivery.orderProductMapping.sendTailText;
    if (sendTailText) {
      text += `\n\n${sendTailText}`;
    }
    text = applyReplaceCharacters(text, orderDelivery);

    const deliveryMethod = orderDelivery.deliveryMethod;
    const deliveryHistory = new DeliverySendHistoryEntity();
    deliveryHistory.context = '{}';
    deliveryHistory.isSuccess = true;
    deliveryHistory.target = decryptedDeliveryTarget;
    deliveryHistory.deliveryMethod = deliveryMethod;

    const encryptKey = this.cryptoCipher.encryptJson({
      id: orderDelivery.id,
      transactionId: orderDelivery.transactionId,
    } as OrderEncryptKey);

    // 5. 발송 채널별 처리
    if (deliveryMethod === IOrderSendMethod.ALIM_TALK) {
      await this.sendAlimTalk(orderDelivery, decryptedDeliveryTarget, encryptKey, title, text, filePathList, deliveryHistory);
    } else if (deliveryMethod === IOrderSendMethod.MMS) {
      await this.sendSms(orderDelivery, decryptedDeliveryTarget, encryptKey, title, text, filePathList, deliveryHistory);
    } else if (deliveryMethod === IOrderSendMethod.EMAIL) {
      await this.sendEmail(orderDelivery, decryptedDeliveryTarget, encryptKey, title, text, deliveryHistory);
    }

    // 6. 발송 실패 시 환불 처리
    if (orderDelivery.status === IOrderDeliveryStatus.FAIL) {
      await this.refundForFail(orderDelivery);
    }

    // 7. DB 저장
    await this.orderDeliveryRepository.save(orderDelivery);

    return { deliveryHistory, orderId: order.id };
  }

  /**
   * 알림톡 발송
   */
  private async sendAlimTalk(
    orderDelivery: OrderDeliveryEntity,
    decryptedDeliveryTarget: string,
    encryptKey: string,
    title: string,
    text: string,
    filePathList: string[],
    deliveryHistory: DeliverySendHistoryEntity,
  ): Promise<void> {
    return this.deliverySendService.sendAlimTalk(orderDelivery, decryptedDeliveryTarget, encryptKey, title, text, filePathList, deliveryHistory);
  }

  /**
   * SMS 발송
   */
  private async sendSms(
    orderDelivery: OrderDeliveryEntity,
    decryptedDeliveryTarget: string,
    encryptKey: string,
    title: string,
    text: string,
    filePathList: string[],
    deliveryHistory: DeliverySendHistoryEntity,
  ): Promise<void> {
    return this.deliverySendService.sendSms(orderDelivery, decryptedDeliveryTarget, encryptKey, title, text, filePathList, deliveryHistory);
  }

  /**
   * 이메일 발송
   */
  private async sendEmail(
    orderDelivery: OrderDeliveryEntity,
    decryptedDeliveryTarget: string,
    encryptKey: string,
    title: string,
    text: string,
    deliveryHistory: DeliverySendHistoryEntity,
  ): Promise<void> {
    return this.deliverySendService.sendEmail(orderDelivery, decryptedDeliveryTarget, encryptKey, title, text, deliveryHistory);
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
   * SMS 발송 텍스트 구성 (SSG 템플릿 + 초이스 쿠폰 URL 적용)
   */
  private buildSmsText(orderDelivery: OrderDeliveryEntity, encryptKey: string, text: string): string {
    return this.deliverySendService.buildSmsText(orderDelivery, encryptKey, text);
  }

  /**
   * 알림톡 실패 시 SMS fallback 발송
   */
  private async handleAlimTalkFail(
    orderDelivery: OrderDeliveryEntity,
    title: string,
    text: string,
    filePathList: string[],
    decryptedDeliveryTarget: string,
    encryptKey: string,
  ): Promise<IOrderDeliveryStatus.COMPLETE_SMS | unknown> {
    try {
      const smsText = this.buildSmsText(orderDelivery, encryptKey, text);
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

        // SSG FAIL 재발송: 잔액 충분한 행사 재선택 + 잔액 선차감
        if (order.type === IOrderType.SSG && orderDelivery.status === IOrderDeliveryStatus.FAIL) {
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
          // PIN 실패 시 선차감 환불
          if (resendDeducted && ssgEvent) {
            try {
              await this.ssgEventService.refundForDeliveryFail(ssgEvent.id, order.id, product.price);
            } catch (refundError) {
              this.logger.error(`[RESEND] 선차감 환불 실패 - orderDelivery.id: ${orderDelivery.id}, error: ${refundError}`);
            }
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
        if (hadNoBarCode || orderDelivery.status === IOrderDeliveryStatus.FAIL) {
          await this.reverseRefundForResend(orderDelivery, resendDeducted);
        }

        this.logger.log(`[RESEND] PIN 발급/확인 성공 - orderDelivery.id: ${orderDelivery.id}, barCode: ${orderDelivery.barCode}`);
      } catch (error) {
        this.logger.error(`[RESEND] PIN 발급/확인 실패 - orderDelivery.id: ${orderDelivery.id}, error: ${error}`);
        // issue() throw 시에도 선차감 환불
        if (resendDeducted && ssgEvent) {
          try {
            await this.ssgEventService.refundForDeliveryFail(ssgEvent.id, order.id, product.price);
          } catch (refundError) {
            this.logger.error(`[RESEND] 선차감 환불 실패 - orderDelivery.id: ${orderDelivery.id}, error: ${refundError}`);
          }
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
   * 환불 복구 (PIN 재발급 성공 시)
   * 최초 발송 실패 시 환불된 금액을 다시 차감
   * @param skipSsg SSG 선차감이 이미 완료된 경우 true (SSG chargeBack 스킵)
   */
  private async reverseRefundForResend(orderDelivery: OrderDeliveryEntity, skipSsg: boolean = false): Promise<void> {
    const order = orderDelivery.orderProductMapping.order;
    const mapping = orderDelivery.orderProductMapping;
    const productPrice = mapping.product.price;
    const settlementPrice = this.calculateSettlementPrice(mapping, order.cardSurchargeApplied, orderDelivery);
    // 과금 대상 userId (대행주문인 경우 clientUserId, 아니면 userId)
    const userId = order.clientUserId ?? order.user!.id;

    try {
      // SSG 이벤트 잔액은 쿠폰 액면가(productPrice) 기준
      if (!skipSsg && order.type === IOrderType.SSG && orderDelivery.ssgEventId) {
        await this.ssgEventService.chargeBackForResend(orderDelivery.ssgEventId, order.id, productPrice);
      }

      // 사용자 잔액/정산은 정산단가(settlementPrice) 기준
      if (order.isSettleBalance) {
        await this.userManagementService.deductBalance(userId, settlementPrice);
      } else {
        const user = await this.userRepository.findOne({ where: { id: userId } });
        if (user) {
          user.allSettleAmount += settlementPrice;
          await this.userRepository.save(user);
        }
      }

      this.logger.log(`[RESEND] 환불 복구 완료 - orderDelivery.id: ${orderDelivery.id}, amount: ${settlementPrice} (정가: ${productPrice})`);
    } catch (error) {
      this.logger.error(`[RESEND] 환불 복구 실패 - orderDelivery.id: ${orderDelivery.id}, error: ${error}`);
      // 환불 복구 실패해도 발송은 진행 (로그만 남김)
    }
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
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .leftJoinAndSelect('choiceSelectProduct.brand', 'choiceBrand')
      .where('orderDelivery.id = :id', { id: orderDeliveryId })
      .getOne();

    if (!orderDelivery) {
      throw new Error('발송 데이터가 존재하지 않습니다.');
    }

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
    let text = orderDelivery.orderProductMapping.sendContent ?? '';
    if (orderDelivery.orderProductMapping.product.memo && orderDelivery.orderProductMapping.order.type !== IOrderType.SSG) {
      text += `\n\n${orderDelivery.orderProductMapping.product.memo}`;
    }
    const sendTailText = orderDelivery.orderProductMapping.sendTailText;
    if (sendTailText) {
      text += `\n\n${sendTailText}`;
    }
    text = applyReplaceCharacters(text, orderDelivery);

    const encryptKey = this.cryptoCipher.encryptJson({
      id: orderDelivery.id,
      transactionId: orderDelivery.transactionId,
    } as OrderEncryptKey);

    const smsText = this.buildSmsText(orderDelivery, encryptKey, text);

    const filePathList: string[] = [];
    if (orderDelivery.imagePath) {
      filePathList.push(orderDelivery.imagePath);
    }

    const fromPhoneNumber = orderDelivery.orderProductMapping.fromPhoneNumber || defaultFromPhoneNumber;
    await this.smsSend.send({
      msgType: 'M',
      to: phoneNumber,
      from: fromPhoneNumber,
      subject: title,
      text: smsText,
      filePath: filePathList,
    });
  }

  async csResendAsAlimTalk(orderDeliveryId: number): Promise<void> {
    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'company')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .leftJoinAndSelect('choiceSelectProduct.brand', 'choiceBrand')
      .where('orderDelivery.id = :id', { id: orderDeliveryId })
      .getOne();

    if (!orderDelivery) {
      throw new Error('발송 데이터가 존재하지 않습니다.');
    }

    const isUnselectedChoiceCoupon = orderDelivery.orderProductMapping.product.type === IProductType.CHOICE && !orderDelivery.choiceSelectProductId;
    if (!orderDelivery.barCode && !isUnselectedChoiceCoupon) {
      throw new Error('쿠폰이 발급되지 않은 건은 알림톡 재발송이 불가능합니다.');
    }

    // 수신 전화번호 결정
    const phoneNumber = orderDelivery.deliveryMethod === IOrderSendMethod.EMAIL && orderDelivery.emailReceiverPhone
      ? this.decryptDeliveryTarget(orderDelivery, 'emailReceiverPhone')
      : this.decryptDeliveryTarget(orderDelivery);

    const alimTalk = AlimTalkTemplate(orderDelivery);

    const encryptKey = this.cryptoCipher.encryptJson({
      id: orderDelivery.id,
      transactionId: orderDelivery.transactionId,
    } as OrderEncryptKey);

    const { report } = await this.deliveryAlimTalk.send({
      to: phoneNumber,
      text: alimTalk,
      encryptKey: encryptKey,
    });

    if (report.code !== 'A000') {
      throw new Error('알림톡 발송에 실패했습니다.');
    }
  }

  async csResendAsSms(orderDeliveryId: number): Promise<void> {
    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .leftJoinAndSelect('choiceSelectProduct.brand', 'choiceBrand')
      .where('orderDelivery.id = :id', { id: orderDeliveryId })
      .getOne();

    if (!orderDelivery) {
      throw new Error('발송 데이터가 존재하지 않습니다.');
    }

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
      } as OrderEncryptKey);
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
    const fromPhoneNumber = orderDelivery.orderProductMapping.fromPhoneNumber || defaultFromPhoneNumber;

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
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .where('orderDelivery.id = :id', { id: orderDeliveryId })
      .getOne();

    if (!orderDelivery) {
      throw new Error('발송 데이터가 존재하지 않습니다.');
    }

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
    } as OrderEncryptKey);

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
    // 재발송인 경우 chargeBack 후 발송 실패 시 재환불이 필요한지 판단하기 위해 이전 상태 저장
    const wasFailBefore = !testOrderDeliveryId && orderDelivery.status === IOrderDeliveryStatus.FAIL;

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
    let text = orderDelivery.orderProductMapping.sendContent ?? '';

    // 이메일이 아닌 경우에만 상품 유의사항 추가
    if (
      orderDelivery.orderProductMapping.product.memo &&
      orderDelivery.deliveryMethod !== IOrderSendMethod.EMAIL &&
      orderDelivery.orderProductMapping.order.type !== IOrderType.SSG
    ) {
      text += `\n\n${orderDelivery.orderProductMapping.product.memo}`;
    }

    const sendTailText = orderDelivery.orderProductMapping.sendTailText;
    if (sendTailText) {
      text += `\n\n${sendTailText}`;
    }
    text = applyReplaceCharacters(text, orderDelivery);

    const deliveryMethod = orderDelivery.deliveryMethod;
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
    } as OrderEncryptKey);

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
        deliveryHistory.context = JSON.stringify(e);
        deliveryHistory.isSuccess = false;
        const resultSms = await this.handleAlimTalkFail(orderDelivery, title, text, filePathList, decryptedDeliveryTarget, encryptKey);

        if (resultSms === IOrderDeliveryStatus.COMPLETE_SMS) {
          deliveryHistory.isSuccess = true;
          this.markSendSuccess(orderDelivery, IOrderDeliveryStatus.COMPLETE_SMS);
        } else {
          deliveryHistory.context += JSON.stringify(resultSms);
          this.markSendFail(orderDelivery, IOrderDeliveryStatus.FAIL);
        }
      }
    }

    // SMS 발송
    if (deliveryMethod === IOrderSendMethod.MMS) {
      const smsText = this.buildSmsText(orderDelivery, encryptKey, text);

      try {
        const fromPhoneNumber = orderDelivery.orderProductMapping.fromPhoneNumber!;
        await this.smsSend.send({
          msgType: 'M',
          to: decryptedDeliveryTarget,
          from: fromPhoneNumber,
          subject: title,
          text: smsText,
          filePath: filePathList,
        });
        this.markSendSuccess(orderDelivery, IOrderDeliveryStatus.COMPLETE);
        deliveryHistory.context = text;
      } catch (e) {
        this.markSendFail(orderDelivery, IOrderDeliveryStatus.FAIL);
        deliveryHistory.context = JSON.stringify(e);
        deliveryHistory.isSuccess = false;
      }
    }

    // 이메일 발송
    if (deliveryMethod === IOrderSendMethod.EMAIL) {
      // 이메일 쿠폰이 이미 수령되어 핀이 발급된 경우 (barCode가 있고 emailReceiverPhone이 있는 경우)
      // 이메일 대신 문자로 재발송
      if (orderDelivery.barCode && orderDelivery.emailReceiverPhone) {
        const decryptedEmailReceiverPhone = this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.emailReceiverPhone) ?? orderDelivery.emailReceiverPhone;

        try {
          const fromPhoneNumber = orderDelivery.orderProductMapping.fromPhoneNumber!;
          await this.smsSend.send({
            msgType: 'M',
            to: decryptedEmailReceiverPhone,
            from: fromPhoneNumber,
            subject: title,
            text: text,
            filePath: filePathList,
          });
          this.markSendSuccess(orderDelivery, IOrderDeliveryStatus.COMPLETE);
          deliveryHistory.context = text;
          deliveryHistory.target = decryptedEmailReceiverPhone;
        } catch (e) {
          this.markSendFail(orderDelivery, IOrderDeliveryStatus.FAIL);
          deliveryHistory.context = JSON.stringify(e);
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
        } as OrderEncryptKey);

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
        const emailText = EmailDeliveryTemplate({
          topImagePath: orderDelivery.orderProductMapping.topImagePath,
          productImagePath: orderDelivery.orderProductMapping.product.imagePath,
          text,
          url: url,
          code: emailSendHistory.code!,
          useEmailContent,
          qrCodeImagePath,
        });

        try {
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
          this.markSendSuccess(orderDelivery, IOrderDeliveryStatus.COMPLETE);
          deliveryHistory.context = text;
        } catch (e) {
          this.markSendFail(orderDelivery, IOrderDeliveryStatus.FAIL);
          deliveryHistory.context = JSON.stringify(e);
          deliveryHistory.isSuccess = false;
        }
      }
    }

    // 재발송 시 chargeBack 후 발송이 다시 실패한 경우: 환불 복구
    if (wasFailBefore && orderDelivery.status === IOrderDeliveryStatus.FAIL) {
      await this.refundForFail(orderDelivery);
    }

    if (isSave) {
      await this.orderDeliveryRepository.save(orderDelivery);
    }

    await this.deliverySendHistoryRepository.save(deliveryHistory);

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
      } as OrderEncryptKey);

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
