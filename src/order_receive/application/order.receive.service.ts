import { BadRequestException, Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { applyReplaceCharacters } from '../../common/utils/replace-characters.util';
import {
  OrderReceiveAlimTalkReqDto,
  OrderReceiveEmailReqDto,
  OrderReceiveSelectChoiceProductReqDto,
  OrderReceiveSendToMMsEmailReqDto,
} from '../api/order.receive.req.dto';
import { OrderReceiveAlimTalkResDto, OrderReceiveEmailResDto } from '../api/order.receive.res.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { OrderEntity } from '../../entity/order.entity';
import { Repository } from 'typeorm';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { TestOrderDeliveryEntity } from '../../entity/test.order.delivery.entity';
import { OrderEncryptKey } from '../interface/order.encrypt.key';
import { EmailSendHistoryEntity } from '../../entity/email.send.history.entity';
import { OrderSendEncryptKey } from '../interface/order.send.encrypt.key';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { IOrderSendMethod } from '../../order/interface/order.send.method';
import { ISmsSend } from '../../sms/interface/sms.send';
import { OrderFromService } from '../../order_from/application/order.from.service';
import { getBillingUserId } from '../../order/domain/order.billing-user.helper';
import { OrderDeliveryEmailCouponStatus } from '../../delivery/interface/order.delivery.email.coupon.status';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { Transactional, Propagation } from 'typeorm-transactional';
import { randomUUID } from 'crypto';
import { ChoicePostSendStatus } from '../../delivery/interface/choice.post.send.status';
import { CHOICE_POST_SEND_STALE_MS, EMAIL_COUPON_STALE_MS } from './choice.reentry.const';
import { ProductChoiceMappingEntity } from '../../entity/product.choice.mapping.entity';
import { IProductType } from '../../product/interface/product.type';
import { OrderReceiveChoiceDto } from '../api/dto/order.receive.choice.dto';
import { DeliveryCreateCouponImage } from '../../delivery/infra/delivery.create.coupon.image';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { DeliverySendService } from '../../delivery/application/delivery.send.service';
import { DeliveryAlimTalk } from '../../delivery/interface/delivery.alim.talk';
import { AlimTalkTemplate } from '../../delivery/domain/alim.talk.template';
import { smsCouponInfoTemplate } from '../../delivery/domain/sms.coupon.info.template';
import { smsSsgTemplate } from '../../delivery/domain/sms.ssg.template';
import { IOrderType } from '../../order/interface/order.type';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { addDays, format, subDays } from 'date-fns';
import { normalizeLineBreaks } from '../../delivery/domain/email.delivery.template';
import { resolveExpireDays, couponTokenExpiry } from '../../common/utils/expire.util';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { PhoneUtil } from '../../common/utils/phone.util';

import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);

@Injectable()
export class OrderReceiveService {
  constructor(
    private cryptoCipher: CryptoCipher,
    @InjectRepository(OrderEntity)
    private orderRepository: Repository<OrderEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
    @InjectRepository(TestOrderDeliveryEntity)
    private testOrderDeliveryRepository: Repository<TestOrderDeliveryEntity>,
    @InjectRepository(EmailSendHistoryEntity)
    private emailSendHistoryRepository: Repository<EmailSendHistoryEntity>,
    @InjectRepository(ProductChoiceMappingEntity)
    private productChoiceMappingRepository: Repository<ProductChoiceMappingEntity>,
    @Inject('ISmsSend')
    private smsSend: ISmsSend,
    @Inject('DeliveryAlimTalk')
    private deliveryAlimTalk: DeliveryAlimTalk,
    private partnerCompanyExternService: PartnerCompanyExternService,
    private deliverySendService: DeliverySendService,
    @InjectRepository(SsgEventEntity)
    private ssgEventRepository: Repository<SsgEventEntity>,
    private orderFromService: OrderFromService,
  ) {}

  private assertCouponNotDiscarded(orderDelivery: OrderDeliveryEntity): void {
    if (
      orderDelivery.couponStatus === OrderDeliveryCouponStatus.CANCEL ||
      orderDelivery.couponStatus === OrderDeliveryCouponStatus.REFUND_CANCEL
    ) {
      throw new BadRequestException('폐기된 쿠폰입니다.');
    }
  }

  private assertChoiceProductNotDeleted(orderDelivery: OrderDeliveryEntity): void {
    const product = orderDelivery.orderProductMapping.product;
    if (!product || (product.type === IProductType.CHOICE && product.deletedAt)) {
      throw new BadRequestException('이 쿠폰은 더 이상 제공되지 않습니다. 발송처에 문의해주세요.');
    }
  }

  private loadChoiceOrderDelivery(id: number | undefined) {
    return this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .leftJoinAndSelect('orderProductMapping.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .withDeleted()
      .where('orderDelivery.id = :id', { id })
      .getOne();
  }

  async selectChoiceProduct(getBody: OrderReceiveSelectChoiceProductReqDto) {
    const orderDecrypt = this.cryptoCipher.decryptJson(getBody.encryptKey) as OrderEncryptKey & { emailSendHistoryId?: number; isTest?: boolean };

    // 테스트 발송인 경우 test_order_delivery에서 처리
    if (orderDecrypt.isTest) {
      return this.selectChoiceProductForTest(orderDecrypt, getBody.productId);
    }

    const orderDeliveryId = orderDecrypt.id ?? orderDecrypt.orderDeliveryId;
    const isEmailPath = !!orderDecrypt.emailSendHistoryId;

    const orderDelivery = await this.loadChoiceOrderDelivery(orderDeliveryId);

    if (!orderDelivery) {
      throw new BadRequestException('존재하지 않는 주문 정보입니다.');
    }

    this.assertChoiceProductNotDeleted(orderDelivery);
    this.assertCouponNotDiscarded(orderDelivery);

    const productChoiceMapping = await this.productChoiceMappingRepository
      .createQueryBuilder('productChoiceMapping')
      .innerJoinAndSelect('productChoiceMapping.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .where('productChoiceMapping.productId = :productId', {
        productId: getBody.productId,
      })
      .getOne();
    if (!productChoiceMapping) {
      throw new InternalServerErrorException('choice product not exist');
    }

    // 이미 선택된 경우: 같은 상품 재시도(별도 발송 재시도) / 다른 상품 거부 / legacy 유지 등 idempotent 처리
    if (orderDelivery.choiceSelectProductId != null) {
      return this.handleAlreadySelectedChoice(orderDelivery, productChoiceMapping, isEmailPath, orderDecrypt);
    }

    if (orderDelivery.expireAt) {
      const expireEnd = dayjs(orderDelivery.expireAt).tz('Asia/Seoul').endOf('day');
      if (dayjs().tz('Asia/Seoul').isAfter(expireEnd)) {
        throw new BadRequestException('유효기간이 만료된 쿠폰입니다.');
      }
    }

    // 이메일 경로: 상품 선택만 저장(외부 발급 없음). 별도 발송 불필요 → NOT_REQUIRED.
    // 동시 선택은 choice_select_product_id IS NULL CAS로 단일화한다.
    if (isEmailPath) {
      const res = await this.orderDeliveryRepository
        .createQueryBuilder()
        .update(OrderDeliveryEntity)
        .set({
          choiceSelectProductId: productChoiceMapping.product.id,
          choicePostSendStatus: ChoicePostSendStatus.NOT_REQUIRED,
        })
        .where('id = :id AND choice_select_product_id IS NULL', { id: orderDelivery.id })
        .execute();
      if (res.affected !== 1) {
        const fresh = await this.loadChoiceOrderDelivery(orderDelivery.id);
        if (fresh?.choiceSelectProductId != null && fresh.choiceSelectProductId !== productChoiceMapping.product.id) {
          throw new BadRequestException('선택이 완료된 쿠폰입니다.');
        }
      }
      return;
    }

    // ── 알림톡/MMS 경로 최초 선택 ──
    // 1) selection claim 선점 (CAS). 선점 성공 요청만 외부 PIN 발급을 수행한다.
    const selectionToken = randomUUID();
    const attemptKey = `choice-sel-${orderDelivery.id}`;
    const claim = await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({
        choiceSelectionClaimToken: selectionToken,
        choiceSelectionClaimedAt: () => 'NOW(6)',
        choiceSelectionAttemptKey: attemptKey,
      })
      .where(
        'id = :id AND choice_select_product_id IS NULL AND choice_selection_claimed_at IS NULL AND choice_selection_reconcile_required_at IS NULL',
        { id: orderDelivery.id },
      )
      .execute();
    if (claim.affected !== 1) {
      return this.resolveSelectionClaimConflict(orderDelivery.id, productChoiceMapping, isEmailPath, orderDecrypt);
    }

    // 2) PIN 발급 (외부 호출 — DB 트랜잭션/row lock 유지하지 않음).
    let ssgEvent: SsgEventEntity | null = null;
    if (orderDelivery.orderProductMapping.order.type === IOrderType.SSG && orderDelivery.ssgEventId) {
      ssgEvent = await this.ssgEventRepository.findOne({ where: { id: orderDelivery.ssgEventId } });
    }
    const originalProduct = orderDelivery.orderProductMapping.product;
    orderDelivery.orderProductMapping.product = productChoiceMapping.product;
    try {
      await this.partnerCompanyExternService.issue(orderDelivery, ssgEvent);
    } catch (e) {
      orderDelivery.orderProductMapping.product = originalProduct;
      console.error('초이스 쿠폰 PIN 발급 실패', orderDelivery.id, e);
      // 공급사 멱등/조회 보장이 없으므로 결과 불명 실패는 blind 재발급하지 않는다.
      // reconcile 필요 표시 후 자동 처리를 중단한다(claim 해제하되 reconcile 플래그가 재선점을 막음).
      await this.orderDeliveryRepository
        .createQueryBuilder()
        .update(OrderDeliveryEntity)
        .set({
          choiceSelectionReconcileRequiredAt: () => 'NOW(6)',
          choiceSelectionClaimToken: null,
          choiceSelectionClaimedAt: null,
        })
        .where('id = :id AND choice_selection_claim_token = :token', { id: orderDelivery.id, token: selectionToken })
        .execute();
      throw new InternalServerErrorException('쿠폰 발급에 실패했습니다. 잠시 후 다시 시도하거나 발송처에 문의해주세요.');
    }
    this.updateCouponExpiration(orderDelivery, productChoiceMapping.product);
    orderDelivery.orderProductMapping.product = originalProduct;
    if (orderDelivery.barCode) {
      orderDelivery.imagePath = await this.createCouponImage(productChoiceMapping.product, orderDelivery);
    }

    // 3) 선택 결과 + post-send 초기 상태를 함께 저장하고 selection claim을 해제한다(token 조건 CAS).
    const requiresPostSend = this.requiresChoicePostSend(orderDelivery);
    const postToken = requiresPostSend ? randomUUID() : null;
    const saveRes = await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({
        choiceSelectProductId: productChoiceMapping.product.id,
        barCode: orderDelivery.barCode,
        personalCode: orderDelivery.personalCode,
        couponNum: orderDelivery.couponNum,
        ssgTransactionId: orderDelivery.ssgTransactionId,
        expireAt: orderDelivery.expireAt,
        encourageAt: orderDelivery.encourageAt,
        couponIssuedAt: orderDelivery.couponIssuedAt,
        imagePath: orderDelivery.imagePath,
        choicePostSendStatus: requiresPostSend ? ChoicePostSendStatus.SENDING : ChoicePostSendStatus.NOT_REQUIRED,
        choicePostSendClaimToken: postToken,
        choicePostSendClaimedAt: requiresPostSend ? (() => 'NOW(6)') : null,
        choiceSelectionClaimToken: null,
        choiceSelectionClaimedAt: null,
      })
      .where('id = :id AND choice_selection_claim_token = :token', { id: orderDelivery.id, token: selectionToken })
      .execute();
    if (saveRes.affected !== 1) {
      // claim을 빼앗겼다(예: 운영 reconcile 처리). 중복 발송을 피하기 위해 여기서 종료.
      return;
    }

    // 4) 별도 쿠폰 이미지 발송 (SENDING claim 보유 요청만 수행).
    if (requiresPostSend && postToken) {
      await this.performChoicePostSend(orderDelivery, productChoiceMapping.product, postToken, orderDecrypt);
    }
  }

  /**
   * 별도 발송 대상 여부 — 발송 "시도" 대상만 결정한다(성공 여부 아님).
   * EMAIL 경로 제외, barCode 존재, ALIM_TALK+COMPLETE(쿠폰뷰 직접 표시) 제외.
   */
  private requiresChoicePostSend(orderDelivery: OrderDeliveryEntity): boolean {
    return (
      orderDelivery.deliveryMethod !== IOrderSendMethod.EMAIL &&
      orderDelivery.barCode != null &&
      !(
        orderDelivery.deliveryMethod === IOrderSendMethod.ALIM_TALK &&
        orderDelivery.status === IOrderDeliveryStatus.COMPLETE
      )
    );
  }

  /**
   * migration 이전 legacy 행(choicePostSendStatus=null) 한정 재진입 차단 근사값.
   * 신규 행에는 사용하지 않으며 배포 시점 이전 쿠폰 만료 후 제거 대상.
   */
  private isLegacyChoiceReentryBlocked(orderDelivery: OrderDeliveryEntity): boolean {
    return (
      orderDelivery.choicePostSendStatus == null &&
      orderDelivery.choiceSelectProductId != null &&
      orderDelivery.barCode != null &&
      orderDelivery.deliveryMethod !== IOrderSendMethod.EMAIL &&
      !(
        orderDelivery.deliveryMethod === IOrderSendMethod.ALIM_TALK &&
        orderDelivery.status === IOrderDeliveryStatus.COMPLETE
      )
    );
  }

  /** alimTalk 응답 blockChoiceReentry 계산. */
  private computeBlockChoiceReentry(orderDelivery: OrderDeliveryEntity): boolean {
    if (orderDelivery.orderProductMapping.product.type !== IProductType.CHOICE) return false;
    if (orderDelivery.deliveryMethod === IOrderSendMethod.EMAIL) return false;

    const staleThreshold = new Date(Date.now() - CHOICE_POST_SEND_STALE_MS);
    const isActiveChoicePostSend =
      orderDelivery.choicePostSendStatus === ChoicePostSendStatus.SENDING &&
      orderDelivery.choicePostSendClaimedAt != null &&
      orderDelivery.choicePostSendClaimedAt >= staleThreshold;

    return (
      isActiveChoicePostSend ||
      orderDelivery.choicePostSendStatus === ChoicePostSendStatus.SENT ||
      this.isLegacyChoiceReentryBlocked(orderDelivery)
    );
  }

  /**
   * post-send SENDING claim 재선점(FAILED 재시도 / stale SENDING 복구용). affected===1 만 외부 발송.
   * legacy(null)는 의도적으로 제외 — 자동 재발송하지 않는다.
   */
  private async claimChoicePostSend(id: number, newToken: string): Promise<boolean> {
    const staleThreshold = new Date(Date.now() - CHOICE_POST_SEND_STALE_MS);
    const res = await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({
        choicePostSendStatus: ChoicePostSendStatus.SENDING,
        choicePostSendClaimToken: newToken,
        choicePostSendClaimedAt: () => 'NOW(6)',
      })
      .where(
        '(choice_post_send_status = :failed OR (choice_post_send_status = :sending AND choice_post_send_claimed_at < :stale)) AND id = :id',
        { id, failed: ChoicePostSendStatus.FAILED, sending: ChoicePostSendStatus.SENDING, stale: staleThreshold },
      )
      .execute();
    return res.affected === 1;
  }

  /** post-send 완료 — 현재 요청의 SENDING claim만 종료. SENT(terminal)는 늦은 실패가 덮어쓰지 못한다. */
  private async completeChoicePostSend(id: number, token: string, success: boolean): Promise<void> {
    const qb = this.orderDeliveryRepository.createQueryBuilder().update(OrderDeliveryEntity);
    if (success) {
      qb.set({
        choicePostSendStatus: ChoicePostSendStatus.SENT,
        choicePostSentAt: () => 'NOW(6)',
        choicePostSendClaimToken: null,
        choicePostSendClaimedAt: null,
      });
    } else {
      qb.set({
        choicePostSendStatus: ChoicePostSendStatus.FAILED,
        choicePostSendClaimToken: null,
        choicePostSendClaimedAt: null,
      });
    }
    await qb
      .where('id = :id AND choice_post_send_status = :sending AND choice_post_send_claim_token = :token', {
        id,
        sending: ChoicePostSendStatus.SENDING,
        token,
      })
      .execute();
  }

  /** 선택 후 별도 쿠폰 이미지 SMS 발송 + 결과를 SENT/FAILED로 기록. */
  private async performChoicePostSend(
    orderDelivery: OrderDeliveryEntity,
    selectedProduct: ProductChoiceMappingEntity['product'],
    token: string,
    orderDecrypt: OrderEncryptKey,
  ): Promise<void> {
    let success = false;
    try {
      orderDelivery.choiceSelectProduct = selectedProduct;
      const decryptedPhone = this.cryptoCipher.decryptDeliveryTarget(orderDelivery.deliveryTarget);
      const body = applyReplaceCharacters(orderDelivery.orderProductMapping.sendContent ?? '', orderDelivery);
      const memoSourceProduct = orderDelivery.choiceSelectProduct ?? orderDelivery.orderProductMapping.product;
      const memoRaw = memoSourceProduct.memo;
      const memo = memoRaw && orderDelivery.orderProductMapping.order.type !== IOrderType.SSG
        ? applyReplaceCharacters(memoRaw, orderDelivery)
        : null;
      const tailRaw = orderDelivery.orderProductMapping.sendTailText;
      const tailText = tailRaw ? applyReplaceCharacters(tailRaw, orderDelivery) : null;
      // 만료 재계산(updateCouponExpiration) 후이므로 토큰 _exp도 새 쿠폰 expireAt 기준으로 재발급
      const refreshedEncryptKey = this.cryptoCipher.encryptJson(
        orderDecrypt,
        couponTokenExpiry(orderDelivery.expireAt),
      );
      const smsText = this.deliverySendService.buildSmsText(orderDelivery, refreshedEncryptKey, body, memo, tailText);
      const filePathList: string[] = orderDelivery.imagePath ? [orderDelivery.imagePath] : [];
      const fromPhoneNumber =
        orderDelivery.orderProductMapping.fromPhoneNumber ||
        (await this.orderFromService.resolveSendDefaultPhone(getBillingUserId(orderDelivery.orderProductMapping.order)));
      const title = orderDelivery.orderProductMapping.sendTitle ?? '';
      await this.smsSend.send({
        msgType: 'M',
        to: decryptedPhone,
        from: fromPhoneNumber,
        subject: title,
        text: smsText,
        filePath: filePathList,
      });
      success = true;
    } catch (e) {
      console.error('초이스 쿠폰 선택 후 SMS 발송 실패', orderDelivery.id, e);
    }
    await this.completeChoicePostSend(orderDelivery.id, token, success);
  }

  /**
   * 이미 선택된 초이스 쿠폰 재요청 처리.
   * - 다른 상품: 거부. 같은 상품: 상태별 idempotent 재시도.
   */
  private async handleAlreadySelectedChoice(
    orderDelivery: OrderDeliveryEntity,
    requestedMapping: ProductChoiceMappingEntity,
    isEmailPath: boolean,
    orderDecrypt: OrderEncryptKey,
  ): Promise<void> {
    if (requestedMapping.product.id !== orderDelivery.choiceSelectProductId) {
      throw new BadRequestException('선택이 완료된 쿠폰입니다.');
    }
    // 이메일 경로는 별도 발송 모델을 쓰지 않는다(발송은 sendToMMS).
    if (isEmailPath) return;

    const status = orderDelivery.choicePostSendStatus;
    // legacy(null): 자동 재발송하지 않는다.
    if (status == null) return;
    // 표시만(NOT_REQUIRED) 또는 이미 발송 완료(SENT): 중복 처리하지 않는다.
    if (status === ChoicePostSendStatus.NOT_REQUIRED || status === ChoicePostSendStatus.SENT) return;

    if (status === ChoicePostSendStatus.SENDING) {
      const staleThreshold = new Date(Date.now() - CHOICE_POST_SEND_STALE_MS);
      // 활성 SENDING: 다른 요청 처리 중 → 중복 처리하지 않는다.
      if (orderDelivery.choicePostSendClaimedAt && orderDelivery.choicePostSendClaimedAt >= staleThreshold) return;
      // stale SENDING → 아래에서 재선점.
    }

    // FAILED 또는 stale SENDING: PIN 재발급 없이 별도 발송만 재시도.
    const token = randomUUID();
    const claimed = await this.claimChoicePostSend(orderDelivery.id, token);
    if (!claimed) return; // 다른 요청이 먼저 재선점했다.
    await this.performChoicePostSend(orderDelivery, requestedMapping.product, token, orderDecrypt);
  }

  /**
   * 최초 선택 claim 선점 실패 시 처리.
   * - 이미 선택 완료: idempotent 재시도 경로로.
   * - reconcile 필요/활성 claim: 안내 후 중단.
   * - stale claim: reconcile 표시 후 중단(blind 재발급 금지).
   */
  private async resolveSelectionClaimConflict(
    id: number,
    requestedMapping: ProductChoiceMappingEntity,
    isEmailPath: boolean,
    orderDecrypt: OrderEncryptKey,
  ): Promise<void> {
    const fresh = await this.loadChoiceOrderDelivery(id);
    if (!fresh) {
      throw new BadRequestException('존재하지 않는 주문 정보입니다.');
    }
    if (fresh.choiceSelectProductId != null) {
      return this.handleAlreadySelectedChoice(fresh, requestedMapping, isEmailPath, orderDecrypt);
    }
    if (fresh.choiceSelectionReconcileRequiredAt != null) {
      throw new BadRequestException('이전 발급 요청을 확인 중입니다. 잠시 후 다시 시도하거나 발송처에 문의해주세요.');
    }
    const staleThreshold = new Date(Date.now() - CHOICE_POST_SEND_STALE_MS);
    if (fresh.choiceSelectionClaimedAt && fresh.choiceSelectionClaimedAt < staleThreshold) {
      // stale selection claim — 외부 PIN 발급 성공 여부 불명. 자동 재선점 금지, reconcile 표시.
      await this.orderDeliveryRepository
        .createQueryBuilder()
        .update(OrderDeliveryEntity)
        .set({ choiceSelectionReconcileRequiredAt: () => 'NOW(6)' })
        .where(
          'id = :id AND choice_select_product_id IS NULL AND choice_selection_reconcile_required_at IS NULL',
          { id },
        )
        .execute();
      throw new BadRequestException('이전 발급 요청을 확인 중입니다. 잠시 후 다시 시도하거나 발송처에 문의해주세요.');
    }
    throw new BadRequestException('상품 선택을 처리 중입니다. 잠시 후 다시 시도해주세요.');
  }

  /**
   * EMAIL 쿠폰 발송 claim 선점(CAS). 외부 발송 차단을 위해 outer tx와 무관하게 즉시 커밋한다.
   * - SEND(terminal)는 재선점 불가.
   * - stale claim은 barCode가 있을 때만(=PIN 재발급 없이 발송 재시도) 재선점한다.
   *   barCode가 없으면 외부 PIN 발급 성공 여부가 불명이므로 재선점하지 않는다.
   */
  @Transactional({ propagation: Propagation.REQUIRES_NEW })
  private async claimEmailCoupon(id: number, token: string, attemptKey: string): Promise<boolean> {
    const staleThreshold = new Date(Date.now() - EMAIL_COUPON_STALE_MS);
    const res = await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({
        emailCouponClaimToken: token,
        emailCouponClaimedAt: () => 'NOW(6)',
        emailCouponAttemptKey: attemptKey,
      })
      .where(
        `id = :id
         AND (email_coupon_status IS NULL OR email_coupon_status <> :send)
         AND (email_coupon_claimed_at IS NULL OR (email_coupon_claimed_at < :stale AND bar_code IS NOT NULL))`,
        { id, send: OrderDeliveryEmailCouponStatus.SEND, stale: staleThreshold },
      )
      .execute();
    return res.affected === 1;
  }

  /** PIN 발급 실패로 인한 claim 해제 + FAIL/reconcile 기록. outer tx 롤백과 무관하게 커밋. */
  @Transactional({ propagation: Propagation.REQUIRES_NEW })
  private async releaseEmailCouponClaimAsFail(id: number, token: string, encryptedPhone: string): Promise<void> {
    await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({
        emailCouponStatus: OrderDeliveryEmailCouponStatus.FAIL,
        emailCouponReconcileRequiredAt: () => 'NOW(6)',
        emailCouponClaimToken: null,
        emailCouponClaimedAt: null,
        deliveryTarget: encryptedPhone,
      })
      .where('id = :id AND email_coupon_claim_token = :token AND email_coupon_status <> :send', {
        id,
        token,
        send: OrderDeliveryEmailCouponStatus.SEND,
      })
      .execute();
  }

  /**
   * 테스트 발송용 초이스 쿠폰 상품 선택
   * test_order_delivery에서 조회하여 choiceSelectProductId만 저장
   */
  private async selectChoiceProductForTest(
    orderDecrypt: OrderEncryptKey & { emailSendHistoryId?: number; isTest?: boolean },
    productId: number,
  ) {
    const orderDeliveryId = orderDecrypt.id ?? orderDecrypt.orderDeliveryId;

    const testOrderDelivery = await this.testOrderDeliveryRepository
      .createQueryBuilder('testOrderDelivery')
      .innerJoinAndSelect('testOrderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .where('testOrderDelivery.id = :id', { id: orderDeliveryId })
      .getOne();

    if (!testOrderDelivery) {
      throw new BadRequestException('존재하지 않는 테스트 주문 정보입니다.');
    }

    if (testOrderDelivery.choiceSelectProductId) {
      throw new BadRequestException('선택이 완료된 쿠폰입니다.');
    }

    const productChoiceMapping = await this.productChoiceMappingRepository
      .createQueryBuilder('productChoiceMapping')
      .innerJoinAndSelect('productChoiceMapping.product', 'product')
      .where('productChoiceMapping.productId = :productId', { productId })
      .getOne();
    if (!productChoiceMapping) {
      throw new InternalServerErrorException('choice product not exist');
    }

    testOrderDelivery.choiceSelectProductId = productChoiceMapping.product.id;
    await this.testOrderDeliveryRepository.save(testOrderDelivery);
  }

  async alimTalk(getQuery: OrderReceiveAlimTalkReqDto): Promise<OrderReceiveAlimTalkResDto> {
    const orderDecrypt = this.cryptoCipher.decryptJson(getQuery.encryptKey) as OrderEncryptKey;

    // 테스트 발송인 경우 test_order_delivery 테이블에서 조회
    if (orderDecrypt.isTest) {
      return this.alimTalkForTest(orderDecrypt);
    }

    // 이메일 경로(OrderSendEncryptKey)에서는 id가 없고 orderDeliveryId만 있음
    const orderDeliveryId = orderDecrypt.id ?? orderDecrypt.orderDeliveryId;

    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .leftJoinAndSelect('orderProductMapping.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .withDeleted()
      .where('orderDelivery.id = :id', { id: orderDeliveryId })
      .getOne();

    if (!orderDelivery) {
      throw new BadRequestException('존재하지 않는 주문 정보입니다.');
    }

    this.assertChoiceProductNotDeleted(orderDelivery);
    this.assertCouponNotDiscarded(orderDelivery);

    const choiceProductList: OrderReceiveChoiceDto[] = [];
    let selectChoiceProduct: OrderReceiveChoiceDto | null = null;
    let selectedProductEntity: any = null; // 선택된 상품의 전체 정보 (brand, memo 포함)

    // 초이스 쿠폰일 경우
    if (orderDelivery.orderProductMapping.product.type === IProductType.CHOICE) {
      const productChoiceMappingList = await this.productChoiceMappingRepository
        .createQueryBuilder('productChoiceMapping')
        .innerJoinAndSelect('productChoiceMapping.product', 'product')
        .innerJoinAndSelect('product.brand', 'brand')
        .where('productChoiceMapping.choiceProductId = :choiceProductId', {
          choiceProductId: orderDelivery.orderProductMapping.product.id,
        })
        .getMany();
      if (productChoiceMappingList.length === 0) {
        throw new InternalServerErrorException("choice product's choiceProductMapping is empty");
      }

      for (const productChoiceMapping of productChoiceMappingList) {
        choiceProductList.push({
          id: productChoiceMapping.product.id,
          name: productChoiceMapping.product.name,
          imagePath: productChoiceMapping.product.imagePath,
          price: productChoiceMapping.product.price,
          expireDay: productChoiceMapping.product.expireDay,
          brandNameKorean: productChoiceMapping.product.brand!.nameKorean,
          brandNameEnglish: productChoiceMapping.product.brand!.nameEnglish,
        });

        // 선택한 초이스 상품이 있을 시
        if (orderDelivery.choiceSelectProductId === productChoiceMapping.product.id) {
          selectChoiceProduct = {
            id: productChoiceMapping.product.id,
            name: productChoiceMapping.product.name,
            imagePath: productChoiceMapping.product.imagePath,
            price: productChoiceMapping.product.price,
            expireDay: productChoiceMapping.product.expireDay,
            brandNameKorean: productChoiceMapping.product.brand!.nameKorean,
            brandNameEnglish: productChoiceMapping.product.brand!.nameEnglish,
          };
          // 선택된 상품의 전체 정보 저장 (brand, memo 포함)
          selectedProductEntity = productChoiceMapping.product;
        }
      }
    }

    let text = orderDelivery.orderProductMapping.sendContent ?? '';

    if (orderDelivery.orderProductMapping.sendTailText) {
      text += orderDelivery.orderProductMapping.sendTailText;
    }
    text = applyReplaceCharacters(text, orderDelivery);

    // 초이스쿠폰이고 상품을 선택한 경우, 선택된 상품의 정보 사용
    const displayProduct = selectedProductEntity || orderDelivery.orderProductMapping.product;
    const displayBrand = selectedProductEntity?.brand || orderDelivery.orderProductMapping.product.brand;

    const order = orderDelivery.orderProductMapping.order;
    const userBusinessName = order.clientUser?.company?.businessName ?? order.user!.company?.businessName ?? '';

    return {
      topImagePath: orderDelivery.orderProductMapping.topImagePath,
      midImagePath: orderDelivery.orderProductMapping.midImagePath,
      fromPhoneNumber: orderDelivery.orderProductMapping.fromPhoneNumber!,
      sendTitle: orderDelivery.orderProductMapping.sendTitle ?? '',
      productName: displayProduct.name,
      productImagePath: displayProduct.imagePath,
      brandName: displayBrand!.nameKorean,
      barCode: orderDelivery.barCode!,
      personalCode: orderDelivery.personalCode,
      couponStatus: orderDelivery.couponStatus,
      context: text,
      type: orderDelivery.orderProductMapping.product.type,
      choiceProductList,
      selectChoiceProduct,
      memo: displayProduct.memo ? normalizeLineBreaks(displayProduct.memo, '<br>') : '',
      sendRequestAt: format(orderDelivery.sendRequestAt, DateFormatStr),
      expireDay: displayProduct.expireDay,
      brandKoreanName: displayBrand!.nameKorean === '신세계' ? '이마트' : displayBrand!.nameKorean,
      userBusinessName,
      partnerCompany: displayProduct.partnerCompany?.type || null,
      validityStartsNextDay: displayProduct.partnerCompany?.validityStartsNextDay,
      expireAt: orderDelivery.expireAt ? dayjs(orderDelivery.expireAt).format('YYYY-MM-DD') : null,
      blockChoiceReentry: this.computeBlockChoiceReentry(orderDelivery),
    };
  }

  /**
   * 테스트 발송용 알림톡 쿠폰 정보 조회
   */
  private async alimTalkForTest(
    orderDecrypt: OrderEncryptKey,
  ): Promise<OrderReceiveAlimTalkResDto> {
    const orderDeliveryId = orderDecrypt.id ?? orderDecrypt.orderDeliveryId;

    const testOrderDelivery = await this.testOrderDeliveryRepository
      .createQueryBuilder('testOrderDelivery')
      .withDeleted()
      .innerJoinAndSelect('testOrderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .where('testOrderDelivery.id = :id', { id: orderDeliveryId })
      .getOne();

    if (!testOrderDelivery) {
      throw new BadRequestException('존재하지 않는 테스트 주문 정보입니다.');
    }

    const choiceProductList: OrderReceiveChoiceDto[] = [];

    // 초이스 쿠폰일 경우 목록 조회 (테스트에서는 선택 불가)
    if (testOrderDelivery.orderProductMapping.product.type === IProductType.CHOICE) {
      const productChoiceMappingList = await this.productChoiceMappingRepository
        .createQueryBuilder('productChoiceMapping')
        .innerJoinAndSelect('productChoiceMapping.product', 'product')
        .innerJoinAndSelect('product.brand', 'brand')
        .where('productChoiceMapping.choiceProductId = :choiceProductId', {
          choiceProductId: testOrderDelivery.orderProductMapping.product.id,
        })
        .getMany();

      for (const productChoiceMapping of productChoiceMappingList) {
        choiceProductList.push({
          id: productChoiceMapping.product.id,
          name: productChoiceMapping.product.name,
          imagePath: productChoiceMapping.product.imagePath,
          price: productChoiceMapping.product.price,
          expireDay: productChoiceMapping.product.expireDay,
          brandNameKorean: productChoiceMapping.product.brand!.nameKorean,
          brandNameEnglish: productChoiceMapping.product.brand!.nameEnglish,
        });
      }
    }

    let text = testOrderDelivery.orderProductMapping.sendContent ?? '';

    if (testOrderDelivery.orderProductMapping.sendTailText) {
      text += testOrderDelivery.orderProductMapping.sendTailText;
    }
    text = applyReplaceCharacters(text, testOrderDelivery);

    const displayProduct = testOrderDelivery.orderProductMapping.product;
    const displayBrand = testOrderDelivery.orderProductMapping.product.brand;

    const order = testOrderDelivery.orderProductMapping.order;
    const userBusinessName = order.clientUser?.company?.businessName ?? order.user!.company?.businessName ?? '';

    return {
      topImagePath: testOrderDelivery.orderProductMapping.topImagePath,
      midImagePath: testOrderDelivery.orderProductMapping.midImagePath,
      fromPhoneNumber: testOrderDelivery.orderProductMapping.fromPhoneNumber!,
      sendTitle: testOrderDelivery.orderProductMapping.sendTitle ?? '',
      productName: displayProduct.name,
      productImagePath: displayProduct.imagePath,
      brandName: displayBrand!.nameKorean,
      barCode: testOrderDelivery.barCode!,
      personalCode: testOrderDelivery.personalCode,
      couponStatus: testOrderDelivery.couponStatus,
      context: text,
      type: testOrderDelivery.orderProductMapping.product.type,
      choiceProductList,
      selectChoiceProduct: null, // 테스트 발송은 초이스 쿠폰 선택 불가
      memo: displayProduct.memo ? normalizeLineBreaks(displayProduct.memo, '<br>') : '',
      sendRequestAt: format(testOrderDelivery.sendRequestAt, DateFormatStr),
      expireDay: displayProduct.expireDay,
      brandKoreanName: displayBrand!.nameKorean === '신세계' ? '이마트' : displayBrand!.nameKorean,
      userBusinessName,
      partnerCompany: displayProduct.partnerCompany?.type || null,
      validityStartsNextDay: displayProduct.partnerCompany?.validityStartsNextDay,
      expireAt: null, // 테스트 발송은 expireAt 미설정
      blockChoiceReentry: false, // 테스트 주문은 운영 post-selection 상태 모델을 쓰지 않음
    };
  }

  async email(getQuery: OrderReceiveEmailReqDto): Promise<OrderReceiveEmailResDto> {
    const orderDecrypt = this.cryptoCipher.decryptJson(getQuery.encryptKey) as OrderEncryptKey;

    // 테스트 발송인 경우 test_order_delivery에서 조회
    if (orderDecrypt.isTest) {
      return this.emailForTest(orderDecrypt, getQuery.code);
    }

    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .leftJoinAndSelect('orderProductMapping.product', 'product')
      .withDeleted()
      .where('orderDelivery.id = :id', { id: orderDecrypt.id })
      .getOne();
    if (!orderDelivery) {
      throw new BadRequestException('존재하지 않는 주문 정보입니다.');
    }

    this.assertChoiceProductNotDeleted(orderDelivery);
    this.assertCouponNotDiscarded(orderDelivery);

    if (!orderDecrypt.emailHistoryId) {
      throw new BadRequestException('올바른 요청이 아닙니다.');
    }
    const emailSendHistory = await this.emailSendHistoryRepository.findOne({
      where: {
        id: orderDecrypt.emailHistoryId,
      },
    });

    if (!emailSendHistory) {
      throw new BadRequestException('이메일 전송 데이터가 없습니다.');
    }

    if (emailSendHistory.expireAt && emailSendHistory.expireAt < new Date()) {
      throw new BadRequestException('만료된 이메일 인증 코드입니다.');
    }

    if (emailSendHistory.code !== getQuery.code) {
      throw new BadRequestException('코드가 일치하지 않습니다.');
    }

    emailSendHistory.isCertified = true;
    await this.emailSendHistoryRepository.save(emailSendHistory);

    const sendEncryptKey = this.cryptoCipher.encryptJson({
      emailSendHistoryId: emailSendHistory.id,
      orderDeliveryId: orderDelivery.id,
    } as OrderSendEncryptKey, couponTokenExpiry(orderDelivery.expireAt));

    const choiceProductList: OrderReceiveChoiceDto[] = [];
    let selectChoiceProduct: OrderReceiveChoiceDto | null = null;
    let selectedProductEntity: any = null; // 선택된 상품의 전체 정보

    // 초이스 쿠폰일 경우
    if (orderDelivery.orderProductMapping.product.type === IProductType.CHOICE) {
      const productChoiceMappingList = await this.productChoiceMappingRepository
        .createQueryBuilder('productChoiceMapping')
        .innerJoinAndSelect('productChoiceMapping.product', 'product')
        .innerJoinAndSelect('product.brand', 'brand')
        .where('productChoiceMapping.choiceProductId = :choiceProductId', {
          choiceProductId: orderDelivery.orderProductMapping.product.id,
        })
        .getMany();
      if (productChoiceMappingList.length === 0) {
        throw new InternalServerErrorException("choice product's choiceProductMapping is empty");
      }

      for (const productChoiceMapping of productChoiceMappingList) {
        choiceProductList.push({
          id: productChoiceMapping.product.id,
          name: productChoiceMapping.product.name,
          imagePath: productChoiceMapping.product.imagePath,
          price: productChoiceMapping.product.price,
          expireDay: productChoiceMapping.product.expireDay,
          brandNameKorean: productChoiceMapping.product.brand!.nameKorean,
          brandNameEnglish: productChoiceMapping.product.brand!.nameEnglish,
        });

        // 선택한 초이스 상품이 있을 시
        if (orderDelivery.choiceSelectProductId === productChoiceMapping.product.id) {
          selectChoiceProduct = {
            id: productChoiceMapping.product.id,
            name: productChoiceMapping.product.name,
            imagePath: productChoiceMapping.product.imagePath,
            price: productChoiceMapping.product.price,
            expireDay: productChoiceMapping.product.expireDay,
            brandNameKorean: productChoiceMapping.product.brand!.nameKorean,
            brandNameEnglish: productChoiceMapping.product.brand!.nameEnglish,
          };
          // 선택된 상품의 전체 정보 저장
          selectedProductEntity = productChoiceMapping.product;
        }
      }
    }

    // 초이스쿠폰이고 상품을 선택한 경우, 선택된 상품의 정보 사용
    const displayProduct = selectedProductEntity || orderDelivery.orderProductMapping.product;

    return {
      productName: displayProduct.name,
      productImagePath: displayProduct.imagePath,
      sendEncryptKey: sendEncryptKey,
      type: orderDelivery.orderProductMapping.product.type,
      choiceProductList,
      selectChoiceProduct,
      isCouponDelivered: orderDelivery.emailCouponStatus === OrderDeliveryEmailCouponStatus.SEND,
    };
  }

  /**
   * 테스트 발송용 이메일 인증 처리
   */
  private async emailForTest(
    orderDecrypt: OrderEncryptKey,
    code: string,
  ): Promise<OrderReceiveEmailResDto> {
    const testOrderDelivery = await this.testOrderDeliveryRepository
      .createQueryBuilder('testOrderDelivery')
      .innerJoinAndSelect('testOrderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .where('testOrderDelivery.id = :id', { id: orderDecrypt.id })
      .getOne();

    if (!testOrderDelivery) {
      throw new BadRequestException('존재하지 않는 테스트 주문 정보입니다.');
    }

    if (!orderDecrypt.emailHistoryId) {
      throw new BadRequestException('올바른 요청이 아닙니다.');
    }

    const emailSendHistory = await this.emailSendHistoryRepository.findOne({
      where: {
        id: orderDecrypt.emailHistoryId,
      },
    });

    if (!emailSendHistory) {
      throw new BadRequestException('이메일 전송 데이터가 없습니다.');
    }

    if (emailSendHistory.expireAt && emailSendHistory.expireAt < new Date()) {
      throw new BadRequestException('만료된 이메일 인증 코드입니다.');
    }

    if (emailSendHistory.code !== code) {
      throw new BadRequestException('코드가 일치하지 않습니다.');
    }

    emailSendHistory.isCertified = true;
    await this.emailSendHistoryRepository.save(emailSendHistory);

    // 테스트 발송용 sendEncryptKey (isTest 플래그 포함)
    const sendEncryptKey = this.cryptoCipher.encryptJson({
      emailSendHistoryId: emailSendHistory.id,
      orderDeliveryId: testOrderDelivery.id,
      isTest: true,
    } as OrderSendEncryptKey);

    const choiceProductList: OrderReceiveChoiceDto[] = [];
    let selectChoiceProduct: OrderReceiveChoiceDto | null = null;

    // 초이스 쿠폰일 경우 목록 조회
    if (testOrderDelivery.orderProductMapping.product.type === IProductType.CHOICE) {
      const productChoiceMappingList = await this.productChoiceMappingRepository
        .createQueryBuilder('productChoiceMapping')
        .innerJoinAndSelect('productChoiceMapping.product', 'product')
        .innerJoinAndSelect('product.brand', 'brand')
        .where('productChoiceMapping.choiceProductId = :choiceProductId', {
          choiceProductId: testOrderDelivery.orderProductMapping.product.id,
        })
        .getMany();

      for (const productChoiceMapping of productChoiceMappingList) {
        choiceProductList.push({
          id: productChoiceMapping.product.id,
          name: productChoiceMapping.product.name,
          imagePath: productChoiceMapping.product.imagePath,
          price: productChoiceMapping.product.price,
          expireDay: productChoiceMapping.product.expireDay,
          brandNameKorean: productChoiceMapping.product.brand!.nameKorean,
          brandNameEnglish: productChoiceMapping.product.brand!.nameEnglish,
        });

        // 선택한 초이스 상품이 있을 시
        if (testOrderDelivery.choiceSelectProductId === productChoiceMapping.product.id) {
          selectChoiceProduct = {
            id: productChoiceMapping.product.id,
            name: productChoiceMapping.product.name,
            imagePath: productChoiceMapping.product.imagePath,
            price: productChoiceMapping.product.price,
            expireDay: productChoiceMapping.product.expireDay,
            brandNameKorean: productChoiceMapping.product.brand!.nameKorean,
            brandNameEnglish: productChoiceMapping.product.brand!.nameEnglish,
          };
        }
      }
    }

    const displayProduct = testOrderDelivery.orderProductMapping.product;

    return {
      productName: displayProduct.name,
      productImagePath: displayProduct.imagePath,
      sendEncryptKey: sendEncryptKey,
      type: testOrderDelivery.orderProductMapping.product.type,
      choiceProductList,
      selectChoiceProduct,
      isCouponDelivered: false, // 테스트 발송은 운영 발송 상태를 저장하지 않음
    };
  }

  @Transactional()
  async sendToMMS(getBody: OrderReceiveSendToMMsEmailReqDto) {
    let obj: OrderSendEncryptKey;
    try {
      obj = this.cryptoCipher.decryptJson(getBody.sendEncryptKey) as OrderSendEncryptKey;
    } catch (e) {
      throw new BadRequestException('올바른 sendEncryptKey 값 이 아닙니다');
    }

    // 테스트 발송인 경우 별도 처리
    if (obj.isTest) {
      return this.sendToMMSForTest(obj, getBody.phoneNumber);
    }

    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .where('orderDelivery.id = :id', { id: obj.orderDeliveryId })
      .getOne();
    if (!orderDelivery) {
      throw new BadRequestException('존재하지 않는 주문 정보입니다.');
    }

    if (!obj.emailSendHistoryId) {
      throw new BadRequestException('올바른 요청이 아닙니다.');
    }

    // 이메일 발송 건인지 확인
    if (orderDelivery.deliveryMethod !== IOrderSendMethod.EMAIL) {
      throw new BadRequestException('이메일 발송 건이 아닙니다.');
    }

    if (orderDelivery.emailCouponStatus === OrderDeliveryEmailCouponStatus.SEND) {
      throw new BadRequestException('이미 전송한 쿠폰입니다.');
    }

    this.assertCouponNotDiscarded(orderDelivery);

    const emailSendHistory = await this.emailSendHistoryRepository.findOne({
      where: {
        id: obj.emailSendHistoryId,
      },
    });

    if (!emailSendHistory) {
      throw new BadRequestException('이메일 전송 이력이 존재하지 않습니다.');
    }

    if (!emailSendHistory.isCertified) {
      throw new BadRequestException('인증받지 않은 key입니다.');
    }

    // 핸드폰 번호 정규화(하이픈 제거) 후 암호화 저장 — CS 검색은 정규화된 암호문으로 매칭하므로 동일 규칙 적용
    const encryptedPhoneNumber = this.cryptoCipher.encryptDeliveryTarget(
      PhoneUtil.normalizeDeliveryTarget(getBody.phoneNumber),
    );

    // EMAIL 쿠폰 발송 동시성 차단: CAS로 claim을 선점한 요청만 PIN 발급/외부 발송을 수행한다.
    // (read-check만으로는 두 요청이 모두 발송 후 늦은 실패가 SEND를 덮어쓸 수 있음)
    const emailClaimToken = randomUUID();
    const emailClaimed = await this.claimEmailCoupon(
      orderDelivery.id,
      emailClaimToken,
      `email-coupon-${orderDelivery.id}`,
    );
    if (!emailClaimed) {
      throw new BadRequestException('쿠폰 전송을 처리 중입니다. 잠시 후 다시 시도해주세요.');
    }

    // 이메일 쿠폰은 이 시점에 핀 발급 (초이스쿠폰 포함 - 전화번호 입력 후 발급)
    const isChoiceCoupon = orderDelivery.orderProductMapping.product.type === IProductType.CHOICE;
    if (!orderDelivery.barCode) {
      // 초이스쿠폰: 선택된 상품의 협력사 정보로 PIN 발급
      let issueProduct = orderDelivery.orderProductMapping.product;

      if (isChoiceCoupon) {
        if (!orderDelivery.choiceSelectProduct) {
          throw new BadRequestException('상품을 먼저 선택해주세요.');
        }
        const choiceProductMapping = await this.productChoiceMappingRepository
          .createQueryBuilder('productChoiceMapping')
          .innerJoinAndSelect('productChoiceMapping.product', 'product')
          .innerJoinAndSelect('product.brand', 'brand')
          .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
          .where('productChoiceMapping.productId = :productId', {
            productId: orderDelivery.choiceSelectProduct.id,
          })
          .getOne();
        if (!choiceProductMapping) {
          throw new InternalServerErrorException('선택된 초이스 상품 정보를 찾을 수 없습니다.');
        }
        issueProduct = choiceProductMapping.product;
      }

      // SSG 행사 정보 조회 (배치 발송 경로와 동일)
      let ssgEvent: SsgEventEntity | null = null;
      if (orderDelivery.orderProductMapping.order.type === IOrderType.SSG && orderDelivery.ssgEventId) {
        ssgEvent = await this.ssgEventRepository.findOne({
          where: { id: orderDelivery.ssgEventId },
        });
      }

      // PIN 발급 (초이스쿠폰은 선택된 상품으로 임시 교체 후 발급)
      const originalProduct = orderDelivery.orderProductMapping.product;
      orderDelivery.orderProductMapping.product = issueProduct;
      try {
        await this.partnerCompanyExternService.issue(orderDelivery, ssgEvent);
      } catch (e) {
        orderDelivery.orderProductMapping.product = originalProduct;
        // PIN 발급 실패. claim을 해제(REQUIRES_NEW로 outer tx 롤백과 무관하게 커밋)하고 FAIL 기록.
        await this.releaseEmailCouponClaimAsFail(orderDelivery.id, emailClaimToken, encryptedPhoneNumber);
        throw new InternalServerErrorException('쿠폰 발급에 실패했습니다. 다시 시도해주세요.');
      }
      orderDelivery.orderProductMapping.product = originalProduct;

      // PIN 발급 성공 시 유효기간 재계산 + 쿠폰 이미지 생성
      if (orderDelivery.barCode) {
        this.updateCouponExpiration(orderDelivery, issueProduct);
        orderDelivery.imagePath = await this.createCouponImage(issueProduct, orderDelivery);
        // 전체 엔티티 save()는 claim 직전 load된 stale emailCouponClaim* 값으로 DB를 덮어써
        // 최종 update의 WHERE token 매칭을 깨뜨린다(emailReceiverPhone/SEND 누락). 변경 컬럼만 부분 update.
        await this.orderDeliveryRepository.update(orderDelivery.id, {
          imagePath: orderDelivery.imagePath,
          couponIssuedAt: orderDelivery.couponIssuedAt,
          expireAt: orderDelivery.expireAt,
          encourageAt: orderDelivery.encourageAt,
        });
      }
    }

    const title = orderDelivery.orderProductMapping.sendTitle ?? '';
    const filePathList: string[] = [];
    if (orderDelivery.imagePath) {
      filePathList.push(orderDelivery.imagePath);
    }

    let status = IOrderDeliveryStatus.COMPLETE;
    let emailCouponStatus = OrderDeliveryEmailCouponStatus.SEND;

    // 만료 재계산(updateCouponExpiration) 후이므로 토큰 _exp도 새 쿠폰 expireAt 기준으로 재발급
    const refreshedSendEncryptKey = this.cryptoCipher.encryptJson(
      obj,
      couponTokenExpiry(orderDelivery.expireAt),
    );

    try {
      // 1차: 알림톡 발송 시도 (기존 등록 템플릿 사용)
      const alimTalkText = AlimTalkTemplate(orderDelivery);
      const { report } = await this.deliveryAlimTalk.send({
        to: getBody.phoneNumber,
        text: alimTalkText,
        encryptKey: refreshedSendEncryptKey,
      });

      if (report.code !== 'A000') {
        throw new Error('AlimTalk Send Error');
      }
    } catch (alimTalkError) {
      // 2차: 알림톡 실패 시 MMS 폴백 (배치 문자 발송 패턴과 동일)
      let mmsText = orderDelivery.orderProductMapping.sendContent ?? '';

      if (orderDelivery.orderProductMapping.product.memo
          && orderDelivery.orderProductMapping.order.type !== IOrderType.SSG) {
        mmsText += `\n\n${orderDelivery.orderProductMapping.product.memo}`;
      }

      const sendTailText = orderDelivery.orderProductMapping.sendTailText;
      if (sendTailText) {
        mmsText += `\n\n${sendTailText}`;
      }

      mmsText = applyReplaceCharacters(mmsText, orderDelivery);

      const mmsFromPhoneNumber = await this.orderFromService.resolveSendDefaultPhone(
        getBillingUserId(orderDelivery.orderProductMapping.order),
      );

      const orderType = orderDelivery.orderProductMapping.order.type;
      const productType = orderDelivery.orderProductMapping.product.type;

      if (orderType === IOrderType.SSG) {
        mmsText += smsSsgTemplate(orderDelivery);
      }

      if (orderType !== IOrderType.SSG && productType !== IProductType.CHOICE && orderDelivery.barCode) {
        mmsText += '\n\n' + smsCouponInfoTemplate(orderDelivery);
      }

      try {
        await this.smsSend.send({
          msgType: 'M',
          to: getBody.phoneNumber,
          from: mmsFromPhoneNumber,
          subject: title,
          text: mmsText,
          filePath: filePathList,
        });
      } catch (mmsError) {
        // 알림톡, MMS 모두 실패
        status = IOrderDeliveryStatus.FAIL;
        emailCouponStatus = OrderDeliveryEmailCouponStatus.PIN_ISSUED;
      }
    }

    // 완료: 현재 요청이 보유한 claim만 종료한다(token 조건). SEND(terminal)는 늦은 실패가 덮어쓰지 못한다.
    // 발송 실패(PIN_ISSUED)도 claim을 해제해 발송 재시도를 허용한다.
    await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({
        status,
        emailCouponStatus,
        emailReceiverPhone: encryptedPhoneNumber,
        emailCouponClaimToken: null,
        emailCouponClaimedAt: null,
        ...(status === IOrderDeliveryStatus.FAIL ? { failedAt: () => 'NOW(6)' } : {}),
      })
      .where('id = :id AND email_coupon_claim_token = :token', { id: orderDelivery.id, token: emailClaimToken })
      .execute();
  }

  /**
   * 테스트 이메일 발송 건의 MMS 전송 (테스트용)
   * 실제 핀 발급 없이 테스트 핀(999999)으로 MMS 발송
   */
  private async sendToMMSForTest(obj: OrderSendEncryptKey, phoneNumber: string) {
    const testOrderDelivery = await this.testOrderDeliveryRepository
      .createQueryBuilder('testOrderDelivery')
      .innerJoinAndSelect('testOrderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .leftJoinAndSelect('testOrderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .leftJoinAndSelect('choiceSelectProduct.brand', 'choiceSelectBrand')
      .where('testOrderDelivery.id = :id', { id: obj.orderDeliveryId })
      .getOne();

    if (!testOrderDelivery) {
      throw new BadRequestException('존재하지 않는 테스트 주문 정보입니다.');
    }

    // 이메일 발송 건인지 확인
    if (testOrderDelivery.deliveryMethod !== IOrderSendMethod.EMAIL) {
      throw new BadRequestException('이메일 발송 건이 아닙니다.');
    }

    // 초이스 쿠폰인 경우 선택된 상품 확인
    const isChoiceCoupon = testOrderDelivery.orderProductMapping.product.type === IProductType.CHOICE;
    if (isChoiceCoupon && !testOrderDelivery.choiceSelectProductId) {
      throw new BadRequestException('상품을 먼저 선택해주세요.');
    }

    // 테스트용 바코드 (999999)
    const testBarcode = '999999';

    // 알림톡 템플릿이 쿠폰번호(barCode/personalCode)를 참조하므로 테스트 바코드를 주입
    testOrderDelivery.barCode = testBarcode;
    testOrderDelivery.personalCode = testBarcode;

    // 초이스 쿠폰이면 선택된 상품, 아니면 기본 상품 사용
    const product = (isChoiceCoupon && testOrderDelivery.choiceSelectProduct)
      ? testOrderDelivery.choiceSelectProduct
      : testOrderDelivery.orderProductMapping.product;
    const productExpireDay = product.expireDay || 0;
    const expireDate = productExpireDay ? dayjs().tz('Asia/Seoul').add(productExpireDay, 'day').format('YYYY. MM. DD') : null;

    const { path } = await DeliveryCreateCouponImage(
      product.imagePath,
      product.name,
      testBarcode,
      product.brand!.nameKorean,
      expireDate,
      testOrderDelivery.orderProductMapping.topImagePath,
      testOrderDelivery.orderProductMapping.midImagePath,
      product.type,
    );

    const title = testOrderDelivery.orderProductMapping.sendTitle ?? '';
    const filePathList: string[] = [path];

    // 테스트용 MMS 텍스트 생성 (sendContent 기반, 배치 문자 발송 패턴과 동일)
    let text = testOrderDelivery.orderProductMapping.sendContent ?? '';
    if (product.memo) {
      text += `\n\n${product.memo}`;
    }
    const sendTailText = testOrderDelivery.orderProductMapping.sendTailText;
    if (sendTailText) {
      text += `\n\n${sendTailText}`;
    }
    text = applyReplaceCharacters(text, testOrderDelivery);
    text = `[테스트 발송]\n▷상품명: ${product.name}\n▷쿠폰번호: ${testBarcode}\n▷유효기간: ${expireDate || '없음'}\n\n${text}`;

    const testFromPhoneNumber = await this.orderFromService.resolveSendDefaultPhone(
      getBillingUserId(testOrderDelivery.orderProductMapping.order),
    );

    // 버튼 링크용 암호화 키 (테스트 토큰 재생성)
    const sendEncryptKey = this.cryptoCipher.encryptJson(obj);

    try {
      // 1차: 알림톡 발송 시도 (실발송과 동일하게 등록 템플릿 사용)
      const alimTalkText = AlimTalkTemplate(testOrderDelivery as unknown as OrderDeliveryEntity);
      const { report } = await this.deliveryAlimTalk.send({
        to: phoneNumber,
        text: alimTalkText,
        encryptKey: sendEncryptKey,
      });

      if (report.code !== 'A000') {
        throw new Error('AlimTalk Send Error');
      }
    } catch (alimTalkError) {
      // 2차: 알림톡 실패 시 MMS 폴백 (실발송 sendToMMS와 동일 패턴)
      try {
        await this.smsSend.send({
          msgType: 'M',
          to: phoneNumber,
          from: testFromPhoneNumber,
          subject: title,
          text: text,
          filePath: filePathList,
        });
      } catch (mmsError) {
        throw new InternalServerErrorException('테스트 발송에 실패했습니다.');
      }
    }
  }

  /**
   * 실제 쿠폰 발급 시점 기준 유효기간 재계산 (초이스 선택 / 이메일 전화번호 입력)
   * SSG는 issue() 내부에서 expireAt/encourageAt을 설정하므로 couponIssuedAt만 기록
   */
  private updateCouponExpiration(
    orderDelivery: OrderDeliveryEntity,
    selectedProduct: { galaxiaDuration?: number | null; expireDay: number; partnerCompany?: { validityStartsNextDay?: boolean | null } | null },
  ): void {
    const now = new Date();
    orderDelivery.couponIssuedAt = now;

    const isSsg = orderDelivery.orderProductMapping.order.type === IOrderType.SSG;
    if (!isSsg) {
      const expireDays = resolveExpireDays(
        orderDelivery.orderProductMapping.galaxiaDuration ?? selectedProduct.galaxiaDuration,
        selectedProduct.expireDay,
        selectedProduct.partnerCompany?.validityStartsNextDay,
      );
      orderDelivery.expireAt = addDays(now, expireDays);

      const encourageDay = orderDelivery.orderProductMapping.encourageDay;
      if (encourageDay) {
        orderDelivery.encourageAt = subDays(orderDelivery.expireAt, encourageDay);
      }
    }
  }

  /**
   * 쿠폰 이미지 생성 - 주어진 product 정보로 만료일 계산 후 이미지 생성
   */
  private async createCouponImage(product: any, orderDelivery: OrderDeliveryEntity): Promise<string> {
    let expireDate: string | null = null;
    if (orderDelivery.expireAt) {
      expireDate = dayjs(orderDelivery.expireAt).tz('Asia/Seoul').format('YYYY. MM. DD');
    } else {
      const productExpireDay = product.expireDay || 0;
      const validityStartsNextDay = product.partnerCompany?.validityStartsNextDay ?? true;
      const expireDay = validityStartsNextDay ? productExpireDay : productExpireDay - 1;
      expireDate = expireDay ? dayjs().tz('Asia/Seoul').add(expireDay, 'day').format('YYYY. MM. DD') : null;
    }

    const { path } = await DeliveryCreateCouponImage(
      product.imagePath,
      product.name,
      orderDelivery.barCode!,
      product.brand!.nameKorean,
      expireDate,
      orderDelivery.orderProductMapping.topImagePath,
      orderDelivery.orderProductMapping.midImagePath,
      orderDelivery.orderProductMapping.product.type,
    );

    return path;
  }
}
