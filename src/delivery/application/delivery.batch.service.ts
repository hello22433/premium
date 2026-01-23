import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Transactional } from 'typeorm-transactional';
import { randomUUID } from 'crypto';
import { addDays, subDays } from 'date-fns';
import dayjs from 'dayjs';
import * as QRCode from 'qrcode';

import { OrderEntity } from '../../entity/order.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
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
import { IOrderRealProductStatus } from '../../order_real_product/interface/order.real.product.status';
import { IFileStorage } from '../../file/interface/file.storage';
import { IProductType } from '../../product/interface/product.type';

import { AlimTalkTemplate } from '../domain/alim.talk.template';
import { AlimTalkEncourageTemplate } from '../domain/alim.talk.encourage.template';
import { EmailEncourageTemplate } from '../domain/email.encourage.template';
import { EmailDeliveryTemplate } from '../domain/email.delivery.template';
import { smsSsgTemplate } from '../domain/sms.ssg.template';
import { smsEncourageTemplate } from '../domain/sms.encourage.template';
import { SmsChoiceProductTemplate } from '../domain/sms.choice.product.template';
import { DeliveryTrackingStatus } from '../domain/delivery.tracking.status';
import { OrderEmailSendType } from '../../order/domain/order.email.send.type';
import { EmailType } from '../../mail/domain/email.type';
import { EmailCertifyExpireDay } from '../../const';

import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { OrderEncryptKey } from '../../order_receive/interface/order.encrypt.key';
import { generateRandomCode } from '../../user_find/domain/code.generate';
import { DeliveryTrackHttp } from '../infra/delivery.track.http';
import { DeliveryCreateCouponImage } from '../infra/delivery.create.coupon.image';

import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { SsgEventService } from '../../ssg_event/application/ssg.event.service';
import { UserManagementService } from '../../user_management/application/user.management.service';

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
      return encryptedValue;
    }

    try {
      return this.cryptoCipher.decryptDeliveryTarget(encryptedValue);
    } catch (error) {
      this.logger.error(`Failed to decrypt ${fieldName} for orderDelivery ${orderDelivery.id}: ${error}`);
      return encryptedValue;
    }
  }

  /**
   * 대치문자 치환
   */
  private applyReplaceCharacters(text: string, orderDelivery: OrderDeliveryEntity): string {
    let result = text;
    if (orderDelivery.replaceCharacter1) {
      result = result.replace('{대치문자1}', orderDelivery.replaceCharacter1);
    }
    if (orderDelivery.replaceCharacter2) {
      result = result.replace('{대치문자2}', orderDelivery.replaceCharacter2);
    }
    if (orderDelivery.replaceCharacter3) {
      result = result.replace('{대치문자3}', orderDelivery.replaceCharacter3);
    }
    return result;
  }

  /**
   * 발송 성공 시 actualSendAt 설정
   */
  private markSendSuccess(orderDelivery: OrderDeliveryEntity, status: IOrderDeliveryStatus): void {
    orderDelivery.status = status;
    if (!orderDelivery.actualSendAt) {
      orderDelivery.actualSendAt = new Date();
    }
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

  async issueAndSend() {
    // 현재 이전 시간에 대기중인 모든 쿠폰 발행 및 발송 진행
    const now = new Date();
    const queryBuilder = this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'company')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .where('orderDelivery.sendRequestAt < :now', { now })
      .andWhere('orderDelivery.status = :status', { status: 'WAIT' });

    const orderDeliveryList = await queryBuilder.getMany();

    this.logger.log(`[BATCH] Found ${orderDeliveryList.length} deliveries to send at ${now.toISOString()}`);

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

    this.logger.log(`[BATCH] Processing ${uniqueDeliveryList.length} deliveries with concurrency: ${concurrency}`);

    // 청크 단위로 병렬 처리
    for (let i = 0; i < uniqueDeliveryList.length; i += concurrency) {
      const chunk = uniqueDeliveryList.slice(i, i + concurrency);
      const chunkResults = await Promise.all(
        chunk.map((orderDelivery) => this.processOneDeliveryForBatch(orderDelivery)),
      );
      allResults.push(...chunkResults.filter((r) => r !== null));
      this.logger.log(`[BATCH] Processed ${Math.min(i + concurrency, uniqueDeliveryList.length)}/${uniqueDeliveryList.length}`);
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

    this.logger.log(`[BATCH] Completed. Total: ${uniqueDeliveryList.length}, Success: ${deliveryHistoryList.length}`);
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

        // 쿠폰 이미지 생성
        const partnerCompany = product.partnerCompany;
        const productExpireDay = product.expireDay || 0;
        const validityStartsNextDay = partnerCompany?.validityStartsNextDay ?? true;
        const expireDay = validityStartsNextDay ? productExpireDay : productExpireDay - 1;
        const expireDate = expireDay ? dayjs().add(expireDay, 'day').format('YYYY. MM. DD') : null;

        const { path } = await DeliveryCreateCouponImage(
          product.imagePath,
          product.name,
          orderDelivery.barCode,
          product.brand!.nameKorean,
          expireDate,
          orderDelivery.orderProductMapping.topImagePath,
          orderDelivery.orderProductMapping.midImagePath,
          product.type,
        );
        orderDelivery.imagePath = path;

        this.logger.log(`[BATCH] PIN 발급 성공 - orderDelivery.id: ${orderDelivery.id}, barCode: ${orderDelivery.barCode}`);
      } catch (error) {
        this.logger.error(`[BATCH] PIN 발급 실패 - orderDelivery.id: ${orderDelivery.id}, error: ${error}`);

        const productPrice = product.price;
        const userId = order.user!.id;

        // 환불 처리
        if (order.type === IOrderType.SSG) {
          await this.ssgEventService.refundForDeliveryFail(order.id, productPrice);
        }

        if (order.isSettleBalance) {
          await this.userManagementService.addBalance(userId, productPrice, `발송 실패 환불 (주문번호: ${order.id})`);
        } else {
          const user = await this.userRepository.findOne({ where: { id: userId } });
          if (user) {
            user.allSettleAmount -= productPrice;
            await this.userRepository.save(user);
          }
        }

        orderDelivery.status = IOrderDeliveryStatus.FAIL;
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
    let decryptedDeliveryTarget = orderDelivery.deliveryTarget;
    if (orderDelivery.deliveryTarget) {
      try {
        decryptedDeliveryTarget = this.cryptoCipher.decryptDeliveryTarget(orderDelivery.deliveryTarget);
      } catch (error) {
        this.logger.error(`Failed to decrypt deliveryTarget for orderDelivery ${orderDelivery.id}: ${error}`);
      }
    }

    const title = orderDelivery.orderProductMapping.sendTitle ?? '';

    // 3. 유효기간 설정
    if (order.type !== IOrderType.SSG) {
      const partnerCompany = product.partnerCompany;
      const expireDays =
        partnerCompany?.validityStartsNextDay === false ? product.expireDay - 1 : product.expireDay;

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
    if (orderDelivery.replaceCharacter1) {
      text = text.replace('{대치문자1}', orderDelivery.replaceCharacter1);
    }
    if (orderDelivery.replaceCharacter2) {
      text = text.replace('{대치문자2}', orderDelivery.replaceCharacter2);
    }
    if (orderDelivery.replaceCharacter3) {
      text = text.replace('{대치문자3}', orderDelivery.replaceCharacter3);
    }

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
    } else if (deliveryMethod === IOrderSendMethod.SMS) {
      await this.sendSms(orderDelivery, decryptedDeliveryTarget, encryptKey, title, text, filePathList, deliveryHistory);
    } else if (deliveryMethod === IOrderSendMethod.EMAIL) {
      await this.sendEmail(orderDelivery, decryptedDeliveryTarget, encryptKey, title, text, deliveryHistory);
    }

    // 6. DB 저장
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

      orderDelivery.status = IOrderDeliveryStatus.COMPLETE;
      if (!orderDelivery.actualSendAt) {
        orderDelivery.actualSendAt = new Date();
      }
    } catch (e) {
      deliveryHistory.context = JSON.stringify(e);
      deliveryHistory.isSuccess = false;
      const resultSms = await this.handleAlimTalkFail(orderDelivery, title, text, filePathList, decryptedDeliveryTarget);
      if (resultSms === IOrderDeliveryStatus.COMPLETE_SMS) {
        deliveryHistory.isSuccess = true;
        orderDelivery.status = IOrderDeliveryStatus.COMPLETE_SMS;
        if (!orderDelivery.actualSendAt) {
          orderDelivery.actualSendAt = new Date();
        }
      } else {
        deliveryHistory.context += JSON.stringify(resultSms);
        orderDelivery.status = IOrderDeliveryStatus.FAIL;
      }
    }
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
    let smsText =
      orderDelivery.orderProductMapping.order.type === IOrderType.SSG ? text + smsSsgTemplate(orderDelivery) : text;
    smsText = SmsChoiceProductTemplate(
      orderDelivery,
      `${this.configService.getOrThrow('SMS_CHOICE_URL')}/${encryptKey}`,
      smsText,
    );

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
      orderDelivery.status = IOrderDeliveryStatus.COMPLETE;
      if (!orderDelivery.actualSendAt) {
        orderDelivery.actualSendAt = new Date();
      }
      deliveryHistory.context = text;
    } catch (e) {
      orderDelivery.status = IOrderDeliveryStatus.FAIL;
      deliveryHistory.context = JSON.stringify(e);
      deliveryHistory.isSuccess = false;
    }
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
    const emailSendHistory = new EmailSendHistoryEntity();
    emailSendHistory.orderDeliveryId = orderDelivery.id;
    emailSendHistory.email = decryptedDeliveryTarget;
    emailSendHistory.type = EmailType.COUPON;
    emailSendHistory.code = generateRandomCode();
    emailSendHistory.expireAt = addDays(new Date(), EmailCertifyExpireDay);
    await this.emailSendHistoryRepository.save(emailSendHistory);

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
      orderDelivery.status = IOrderDeliveryStatus.COMPLETE;
      if (!orderDelivery.actualSendAt) {
        orderDelivery.actualSendAt = new Date();
      }
      deliveryHistory.context = text;
    } catch (e) {
      orderDelivery.status = IOrderDeliveryStatus.FAIL;
      deliveryHistory.context = JSON.stringify(e);
      deliveryHistory.isSuccess = false;
    }
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

  private async handleAlimTalkFail(
    orderDelivery: OrderDeliveryEntity,
    title: string,
    text: string,
    filePathList: string[],
    decryptedDeliveryTarget: string,
  ) {
    try {
      const smsText =
        orderDelivery.orderProductMapping.order.type === IOrderType.SSG ? text + smsSsgTemplate(orderDelivery) : text;

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
      orderDelivery.status = IOrderDeliveryStatus.FAIL_SMS;
      return e;
    }
  }

  async oneSend(orderDelivery: OrderDeliveryEntity, isSave: boolean = true, testOrderDeliveryId?: number): Promise<boolean> {
    const decryptedDeliveryTarget = this.decryptDeliveryTarget(orderDelivery);
    const title = orderDelivery.orderProductMapping.sendTitle ?? '';

    if (orderDelivery.orderProductMapping.order.type !== IOrderType.SSG) {
      const partnerCompany = orderDelivery.orderProductMapping.product.partnerCompany;
      const expireDays =
        partnerCompany?.validityStartsNextDay === false
          ? orderDelivery.orderProductMapping.product.expireDay - 1
          : orderDelivery.orderProductMapping.product.expireDay;

      // 실제 발송 시점 기준으로 유효기간 계산 (sendRequestAt이 아닌 현재 시간 사용)
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
    if (orderDelivery.orderProductMapping.product.memo && orderDelivery.deliveryMethod !== IOrderSendMethod.EMAIL) {
      text += `\n\n${orderDelivery.orderProductMapping.product.memo}`;
    }

    const sendTailText = orderDelivery.orderProductMapping.sendTailText;
    if (sendTailText) {
      text += `\n\n${sendTailText}`;
    }
    if (orderDelivery.replaceCharacter1) {
      text = text.replace('{대치문자1}', orderDelivery.replaceCharacter1);
    }
    if (orderDelivery.replaceCharacter2) {
      text = text.replace('{대치문자2}', orderDelivery.replaceCharacter2);
    }
    if (orderDelivery.replaceCharacter3) {
      text = text.replace('{대치문자3}', orderDelivery.replaceCharacter3);
    }

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
        const resultSms = await this.handleAlimTalkFail(orderDelivery, title, text, filePathList, decryptedDeliveryTarget);

        if (resultSms === IOrderDeliveryStatus.COMPLETE_SMS) {
          deliveryHistory.isSuccess = true;
          this.markSendSuccess(orderDelivery, IOrderDeliveryStatus.COMPLETE_SMS);
        } else {
          deliveryHistory.context += JSON.stringify(resultSms);
          orderDelivery.status = IOrderDeliveryStatus.FAIL;
        }
      }
    }

    // SMS 발송
    if (deliveryMethod === IOrderSendMethod.SMS) {
      let smsText =
        orderDelivery.orderProductMapping.order.type === IOrderType.SSG ? text + smsSsgTemplate(orderDelivery) : text;
      smsText = SmsChoiceProductTemplate(
        orderDelivery,
        `${this.configService.getOrThrow('SMS_CHOICE_URL')}/${encryptKey}`,
        smsText,
      );

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
        orderDelivery.status = IOrderDeliveryStatus.COMPLETE;
        if (!orderDelivery.actualSendAt) {
          orderDelivery.actualSendAt = new Date();
        }
        deliveryHistory.context = text;
      } catch (e) {
        orderDelivery.status = IOrderDeliveryStatus.FAIL;
        deliveryHistory.context = JSON.stringify(e);
        deliveryHistory.isSuccess = false;
      }
    }

    // 이메일 발송
    if (deliveryMethod === IOrderSendMethod.EMAIL) {
      // 이메일 쿠폰이 이미 수령되어 핀이 발급된 경우 (barCode가 있고 emailReceiverPhone이 있는 경우)
      // 이메일 대신 문자로 재발송
      if (orderDelivery.barCode && orderDelivery.emailReceiverPhone) {
        let decryptedEmailReceiverPhone = orderDelivery.emailReceiverPhone;
        try {
          decryptedEmailReceiverPhone = this.cryptoCipher.decryptDeliveryTarget(orderDelivery.emailReceiverPhone);
        } catch (error) {
          this.logger.error(`Failed to decrypt emailReceiverPhone for orderDelivery ${orderDelivery.id}: ${error}`);
        }

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
          orderDelivery.status = IOrderDeliveryStatus.COMPLETE;
          if (!orderDelivery.actualSendAt) {
            orderDelivery.actualSendAt = new Date();
          }
          deliveryHistory.context = text;
          deliveryHistory.target = decryptedEmailReceiverPhone;
        } catch (e) {
          orderDelivery.status = IOrderDeliveryStatus.FAIL;
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
          orderDelivery.status = IOrderDeliveryStatus.COMPLETE;
          if (!orderDelivery.actualSendAt) {
            orderDelivery.actualSendAt = new Date();
          }
          deliveryHistory.context = text;
        } catch (e) {
          orderDelivery.status = IOrderDeliveryStatus.FAIL;
          deliveryHistory.context = JSON.stringify(e);
          deliveryHistory.isSuccess = false;
        }
      }
    }

    if (isSave) {
      await this.orderDeliveryRepository.save(orderDelivery);
    }

    await this.deliverySendHistoryRepository.insert([deliveryHistory]);

    // 발송 성공 여부 반환
    return orderDelivery.status === IOrderDeliveryStatus.COMPLETE || orderDelivery.status === IOrderDeliveryStatus.COMPLETE_SMS;
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
      .andWhere('orderDelivery.deliveryTarget != :destroyValue', { destroyValue })
      .getMany();

    const destroyIdList = orderDeliveryList.map((od) => od.id);

    if (destroyIdList.length > 0) {
      await this.orderDeliveryRepository.update(
        { id: In(destroyIdList) },
        { deliveryTarget: destroyValue },
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
          });

          this.logger.log(`독려 알림톡 발송 완료: orderDelivery ${orderDelivery.id}`);
        } catch (e) {
          this.logger.error(`독려 알림톡 발송 실패: orderDelivery ${orderDelivery.id}`, e);
        }
      }

      // 2. SMS 발송
      if (orderDelivery.deliveryMethod === IOrderSendMethod.SMS) {
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
