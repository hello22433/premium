import { Inject, Injectable, Logger } from '@nestjs/common';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { DeliveryAlimTalk } from '../interface/delivery.alim.talk';
import { IOrderDeliveryStatus } from '../interface/order.delivery.status';
import { IMailSend } from '../../mail/interface/mail-send';
import { IOrderSendMethod } from '../../order/interface/order.send.method';
import { DeliverySendHistoryEntity } from '../../entity/delivery.send.history.entity';
import { ISmsSend } from '../../sms/interface/sms.send';
import { OrderEntity } from '../../entity/order.entity';
import { IOrderStatus } from '../../order/interface/order.status';
import { AlimTalkTemplate } from '../domain/alim.talk.template';
import { AlimTalkEncourageTemplate } from '../domain/alim.talk.encourage.template';
import { EmailEncourageTemplate } from '../domain/email.encourage.template';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { OrderEncryptKey } from '../../order_receive/interface/order.encrypt.key';
import { ConfigService } from '@nestjs/config';
import { EmailSendHistoryEntity } from '../../entity/email.send.history.entity';
import { generateRandomCode } from '../../user_find/domain/code.generate';
import { addDays, format, subDays } from 'date-fns';
import { EmailCertifyExpireDay } from '../../const';
import { EmailType } from '../../mail/domain/email.type';
import { IOrderType } from '../../order/interface/order.type';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { smsSsgTemplate } from '../domain/sms.ssg.template';
import { EmailDeliveryTemplate } from '../domain/email.delivery.template';
import { OrderEmailSendType } from '../../order/domain/order.email.send.type';
import * as QRCode from 'qrcode';
import { randomUUID } from 'crypto';
import { IFileStorage } from '../../file/interface/file.storage';
import { SmsChoiceProductTemplate } from '../domain/sms.choice.product.template';
import { IOrderRealProductStatus } from '../../order_real_product/interface/order.real.product.status';
import { OrderRealProductEntity } from '../../entity/order.real.product.entity';
import { DeliveryTrackHttp } from '../infra/delivery.track.http';
import { DeliveryTrackingStatus } from '../domain/delivery.tracking.status';
import { OrderRealProductMappingEntity } from '../../entity/order.real.product.mapping.entity';
import { Transactional } from 'typeorm-transactional';
import { OrderDeliveryCouponStatus } from '../interface/order.delivery.coupon.status';
import { UserEntity } from '../../entity/user.entity';

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
  ) {}

  private logger = new Logger('batch');

  async issueAndSend() {
    // 현재 이전 시간에 대기중인 모든 쿠폰 발행 및 발송 진행
    const now = new Date();
    const queryBuilder = this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('order.user', 'user')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .where('orderDelivery.sendRequestAt < :now', { now })
      .andWhere('orderDelivery.status = :status', { status: 'WAIT' });

    const orderDeliveryList = await queryBuilder.getMany();

    this.logger.log(`[BATCH] Found ${orderDeliveryList.length} deliveries to send at ${now.toISOString()}`);

    // 0. 전송 history 생성 entity list
    const deliveryHistoryList: DeliverySendHistoryEntity[] = [];
    const orderIdList: number[] = [];

    // 1. 알림톡, SMS, 이메일 전송
    for (const orderDelivery of orderDeliveryList) {
      // deliveryTarget 복호화
      let decryptedDeliveryTarget = orderDelivery.deliveryTarget;
      if (orderDelivery.deliveryTarget) {
        try {
          decryptedDeliveryTarget = this.cryptoCipher.decryptDeliveryTarget(orderDelivery.deliveryTarget);
        } catch (error) {
          this.logger.error(`Failed to decrypt deliveryTarget for orderDelivery ${orderDelivery.id}: ${error}`);
          // 복호화 실패 시 원본 데이터 사용
          decryptedDeliveryTarget = orderDelivery.deliveryTarget;
        }
      }

      const title = orderDelivery.orderProductMapping.order.sendTitle;

      if (orderDelivery.orderProductMapping.order.type !== IOrderType.SSG) {
        const partnerCompany = orderDelivery.orderProductMapping.product.partnerCompany;
        const expireDays =
          partnerCompany?.validityStartsNextDay === false
            ? orderDelivery.orderProductMapping.product.expireDay - 1
            : orderDelivery.orderProductMapping.product.expireDay;

        orderDelivery.expireAt = addDays(orderDelivery.sendRequestAt, expireDays);
        if (orderDelivery.orderProductMapping.order.encourageDay) {
          orderDelivery.encourageAt = subDays(
            orderDelivery.expireAt,
            orderDelivery.orderProductMapping.order.encourageDay,
          );
        }
      }

      const filePathList = [];
      if (orderDelivery.imagePath) {
        filePathList.push(orderDelivery.imagePath);
      }
      let text = orderDelivery.orderProductMapping.sendContent ?? orderDelivery.orderProductMapping.order.sendContent;

      // 이메일이 아니고 SSG 타입이 아닌 경우에만 상품 유의사항 추가
      if (
        orderDelivery.orderProductMapping.product.memo &&
        orderDelivery.orderProductMapping.order.type !== IOrderType.SSG &&
        orderDelivery.deliveryMethod !== IOrderSendMethod.EMAIL
      ) {
        text += `\n\n${orderDelivery.orderProductMapping.product.memo}`;
      }

      const sendTailText =
        orderDelivery.orderProductMapping.sendTailText ?? orderDelivery.orderProductMapping.order.sendTailText;
      if (sendTailText) {
        text += sendTailText;
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

      // 1.1 알림톡일 경우
      if (deliveryMethod === IOrderSendMethod.ALIM_TALK) {
        try {
          const alimTalk = AlimTalkTemplate(orderDelivery);
          const { responseData, report } = await this.deliveryAlimTalk.send({
            to: decryptedDeliveryTarget,
            text: alimTalk,
            encryptKey: encryptKey,
          });

          console.log(JSON.stringify(report));
          console.log(JSON.stringify(responseData));
          deliveryHistory.context = JSON.stringify(responseData);
          deliveryHistory.etcContext = JSON.stringify(report);

          if (report.code !== 'A000') {
            throw new Error('AlimTalk Send Error');
          }

          orderDelivery.status = IOrderDeliveryStatus.COMPLETE;
          orderDelivery.actualSendAt = new Date();
        } catch (e) {
          deliveryHistory.context = JSON.stringify(e);
          deliveryHistory.isSuccess = false;
          const resultSms = await this.handleAlimTalkFail(orderDelivery, title, text, filePathList);
          // 문자 전송성공한 경우
          if (resultSms === IOrderDeliveryStatus.COMPLETE_SMS) {
            deliveryHistory.isSuccess = true;
            orderDelivery.status = IOrderDeliveryStatus.COMPLETE_SMS;
            orderDelivery.actualSendAt = new Date();
          }
          // 문자 전송도 실패한 경우
          if (resultSms !== IOrderDeliveryStatus.COMPLETE_SMS) {
            deliveryHistory.context += JSON.stringify(resultSms);
            orderDelivery.status = IOrderDeliveryStatus.COMPLETE_SMS;
          }
        }
      }

      // 1.2 SMS 일 경우
      if (deliveryMethod === IOrderSendMethod.SMS) {
        let smsText =
          orderDelivery.orderProductMapping.order.type === IOrderType.SSG ? text + smsSsgTemplate(orderDelivery) : text;
        smsText = SmsChoiceProductTemplate(
          orderDelivery,
          `${this.configService.getOrThrow('SMS_CHOICE_URL')}/${encryptKey}`,
          smsText,
        );

        try {
          const fromPhoneNumber = orderDelivery.orderProductMapping.fromPhoneNumber
            ? orderDelivery.orderProductMapping.fromPhoneNumber
            : orderDelivery.orderProductMapping.order.fromPhoneNumber!;
          await this.smsSend.send({
            msgType: 'M',
            to: decryptedDeliveryTarget,
            from: fromPhoneNumber,
            subject: title,
            text: smsText,
            filePath: filePathList,
          });
          orderDelivery.status = IOrderDeliveryStatus.COMPLETE;
          orderDelivery.actualSendAt = new Date();
          deliveryHistory.context = text;
        } catch (e) {
          orderDelivery.status = IOrderDeliveryStatus.FAIL;
          deliveryHistory.context = JSON.stringify(e);
          deliveryHistory.isSuccess = false;
        }
      }

      // 1.3 EMAIL 일 경우
      if (deliveryMethod === IOrderSendMethod.EMAIL) {
        const emailSendHistory = new EmailSendHistoryEntity();
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
        const emailSendType =
          orderDelivery.orderProductMapping.emailSendType ?? orderDelivery.orderProductMapping.order.emailSendType;
        if (emailSendType === OrderEmailSendType.QR) {
          const qrCodeBuffer = await QRCode.toBuffer(url);

          // 파일명 생성
          const uuid = randomUUID();
          const fileName = `qr-codes/${uuid}.png`;
          const originalName = `${uuid}.png`;

          const fileUrl = await this.fileStorage.uploadImageFileWithBuffer(qrCodeBuffer, fileName, originalName);
          qrCodeImagePath = fileUrl.url;
        }

        const useEmailContent =
          orderDelivery.orderProductMapping.useEmailContent ?? orderDelivery.orderProductMapping.order.useEmailContent!;

        const emailText = EmailDeliveryTemplate({
          topImagePath: orderDelivery.orderProductMapping.topImagePath,
          productImagePath: orderDelivery.orderProductMapping.product.imagePath,
          text,
          url: url,
          code: emailSendHistory.code,
          useEmailContent: useEmailContent,
          qrCodeImagePath,
        });

        try {
          const fromEmail =
            orderDelivery.orderProductMapping.fromEmail ?? orderDelivery.orderProductMapping.order.fromEmail;
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
          orderDelivery.actualSendAt = new Date();
          deliveryHistory.context = text;
        } catch (e) {
          orderDelivery.status = IOrderDeliveryStatus.FAIL;
          deliveryHistory.context = JSON.stringify(e);
          deliveryHistory.isSuccess = false;
        }
      }
      deliveryHistoryList.push(deliveryHistory);
      orderIdList.push(orderDelivery.orderProductMapping.order.id);
      await this.orderDeliveryRepository.save(orderDelivery);
    }

    await this.deliverySendHistoryRepository.insert(deliveryHistoryList);
    await this.orderRepository.update({ id: In(orderIdList) }, { status: IOrderStatus.DELIVERY_COMPLETE });

    // if (orderIdList.length > 0) {
    //   const orderList = await this.orderRepository
    //     .createQueryBuilder('order')
    //     .innerJoinAndSelect('order.user', 'user')
    //     .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
    //     .where('order.id IN (:...orderIdList)', { orderIdList })
    //     .getMany();
    //
    //   for (const order of orderList) {
    //     await this.userRepository.update(
    //       {
    //         id: order.userId,
    //       },
    //       {
    //         allSettleAmount: order.user!.allSettleAmount + order.settleAmount,
    //       },
    //     );
    //   }
    // }

    return;
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
  ) {
    try {
      const smsText =
        orderDelivery.orderProductMapping.order.type === IOrderType.SSG ? text + smsSsgTemplate(orderDelivery) : text;

      const fromPhoneNumber =
        orderDelivery.orderProductMapping.fromPhoneNumber ?? orderDelivery.orderProductMapping.order.fromPhoneNumber!;
      await this.smsSend.send({
        msgType: 'L',
        to: orderDelivery.deliveryTarget,
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

  async oneSend(orderDelivery: OrderDeliveryEntity, isSave: boolean = true) {
    // deliveryTarget 복호화
    let decryptedDeliveryTarget = orderDelivery.deliveryTarget;
    if (orderDelivery.deliveryTarget) {
      try {
        decryptedDeliveryTarget = this.cryptoCipher.decryptDeliveryTarget(orderDelivery.deliveryTarget);
      } catch (error) {
        this.logger.error(`Failed to decrypt deliveryTarget for orderDelivery ${orderDelivery.id}: ${error}`);
        // 복호화 실패 시 원본 데이터 사용
        decryptedDeliveryTarget = orderDelivery.deliveryTarget;
      }
    }

    // 0. 전송 history 생성 entity list
    const deliveryHistoryList: DeliverySendHistoryEntity[] = [];

    // 1. 알림톡, SMS, 이메일 전송

    const title = orderDelivery.orderProductMapping.sendTitle ?? orderDelivery.orderProductMapping.order.sendTitle;

    if (orderDelivery.orderProductMapping.order.type !== IOrderType.SSG) {
      const partnerCompany = orderDelivery.orderProductMapping.product.partnerCompany;
      const expireDays =
        partnerCompany?.validityStartsNextDay === false
          ? orderDelivery.orderProductMapping.product.expireDay - 1
          : orderDelivery.orderProductMapping.product.expireDay;

      orderDelivery.expireAt = addDays(orderDelivery.sendRequestAt, expireDays);
      if (orderDelivery.orderProductMapping.order.encourageDay) {
        orderDelivery.encourageAt = subDays(
          orderDelivery.expireAt,
          orderDelivery.orderProductMapping.order.encourageDay,
        );
      }
    }

    const filePathList = [];
    if (orderDelivery.imagePath) {
      filePathList.push(orderDelivery.imagePath);
    }
    let text = orderDelivery.orderProductMapping.sendContent ?? orderDelivery.orderProductMapping.order.sendContent;

    // 이메일이 아닌 경우에만 상품 유의사항 추가
    if (orderDelivery.orderProductMapping.product.memo && orderDelivery.deliveryMethod !== IOrderSendMethod.EMAIL) {
      text += `\n\n${orderDelivery.orderProductMapping.product.memo}`;
    }

    const sendTailText =
      orderDelivery.orderProductMapping.sendTailText ?? orderDelivery.orderProductMapping.order.sendTailText;
    if (sendTailText) {
      text += sendTailText;
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

    // 1.1 알림톡일 경우
    if (deliveryMethod === IOrderSendMethod.ALIM_TALK) {
      try {
        const alimTalk = AlimTalkTemplate(orderDelivery);
        const { responseData, report } = await this.deliveryAlimTalk.send({
          to: decryptedDeliveryTarget,
          text: alimTalk,
          encryptKey: encryptKey,
        });

        console.log(JSON.stringify(report));
        console.log(JSON.stringify(responseData));
        deliveryHistory.context = JSON.stringify(responseData);
        deliveryHistory.etcContext = JSON.stringify(report);
        // TODO 알림톡 에러 검증
        if (report.code !== 'A000') {
          throw new Error('AlimTalk Send Error');
        }
        // if (report.code !== 'A000' || report.data.report.length === 0) {
        //   throw new Error('AlimTalk Send Error');
        // }
        // deliveryHistory.context = JSON.stringify(responseData);
        // deliveryHistory.etcContext = JSON.stringify(report);
        orderDelivery.status = IOrderDeliveryStatus.COMPLETE;
        orderDelivery.actualSendAt = new Date();
      } catch (e) {
        deliveryHistory.context = JSON.stringify(e);
        deliveryHistory.isSuccess = false;
        const resultSms = await this.handleAlimTalkFail(orderDelivery, title, text, filePathList);
        // 문자 전송성공한 경우
        if (resultSms === IOrderDeliveryStatus.COMPLETE_SMS) {
          deliveryHistory.isSuccess = true;
          orderDelivery.status = IOrderDeliveryStatus.COMPLETE_SMS;
          orderDelivery.actualSendAt = new Date();
        }
        // 문자 전송도 실패한 경우
        if (resultSms !== IOrderDeliveryStatus.COMPLETE_SMS) {
          deliveryHistory.context += JSON.stringify(resultSms);
          orderDelivery.status = IOrderDeliveryStatus.COMPLETE_SMS;
        }
      }
    }

    // 1.2 SMS 일 경우
    if (deliveryMethod === IOrderSendMethod.SMS) {
      let smsText =
        orderDelivery.orderProductMapping.order.type === IOrderType.SSG ? text + smsSsgTemplate(orderDelivery) : text;
      smsText = SmsChoiceProductTemplate(
        orderDelivery,
        `${this.configService.getOrThrow('SMS_CHOICE_URL')}/${encryptKey}`,
        smsText,
      );

      try {
        const fromPhoneNumber =
          orderDelivery.orderProductMapping.fromPhoneNumber ?? orderDelivery.orderProductMapping.order.fromPhoneNumber!;
        await this.smsSend.send({
          msgType: 'M',
          to: decryptedDeliveryTarget,
          from: fromPhoneNumber,
          subject: title,
          text: smsText,
          filePath: filePathList,
        });
        orderDelivery.status = IOrderDeliveryStatus.COMPLETE;
        orderDelivery.actualSendAt = new Date();
        deliveryHistory.context = text;
      } catch (e) {
        orderDelivery.status = IOrderDeliveryStatus.FAIL;
        deliveryHistory.context = JSON.stringify(e);
        deliveryHistory.isSuccess = false;
      }
    }

    // 1.3 EMAIL 일 경우
    if (deliveryMethod === IOrderSendMethod.EMAIL) {
      const emailSendHistory = new EmailSendHistoryEntity();
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
      const emailSendType =
        orderDelivery.orderProductMapping.emailSendType ?? orderDelivery.orderProductMapping.order.emailSendType;
      if (emailSendType === OrderEmailSendType.QR) {
        const qrCodeBuffer = await QRCode.toBuffer(url);

        // 파일명 생성
        const uuid = randomUUID();
        const fileName = `qr-codes/${uuid}.png`;
        const originalName = `${uuid}.png`;

        const fileUrl = await this.fileStorage.uploadImageFileWithBuffer(qrCodeBuffer, fileName, originalName);
        qrCodeImagePath = fileUrl.url;
      }

      const useEmailContent =
        orderDelivery.orderProductMapping.useEmailContent ?? orderDelivery.orderProductMapping.order.useEmailContent!;
      const emailText = EmailDeliveryTemplate({
        topImagePath: orderDelivery.orderProductMapping.topImagePath,
        productImagePath: orderDelivery.orderProductMapping.product.imagePath,
        text,
        url: url,
        code: emailSendHistory.code,
        useEmailContent: useEmailContent,
        qrCodeImagePath,
      });

      try {
        const fromEmail =
          orderDelivery.orderProductMapping.fromEmail ?? orderDelivery.orderProductMapping.order.fromEmail;
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
        orderDelivery.actualSendAt = new Date();
        deliveryHistory.context = text;
      } catch (e) {
        orderDelivery.status = IOrderDeliveryStatus.FAIL;
        deliveryHistory.context = JSON.stringify(e);
        deliveryHistory.isSuccess = false;
      }
    }
    deliveryHistoryList.push(deliveryHistory);

    if (isSave) {
      await this.orderDeliveryRepository.save(orderDelivery);
    }

    await this.deliverySendHistoryRepository.insert(deliveryHistoryList);

    return;
  }

  @Transactional()
  async deliveryDeliveryTargetDestroy() {
    const now = new Date();
    const destroyPhoneNumber = '000-0000-0000';
    const destroyEmail = '';

    // 파기용 암호화된 값
    const encryptedDestroyPhoneNumber = this.cryptoCipher.encryptDeliveryTarget(destroyPhoneNumber);
    const encryptedDestroyEmail = this.cryptoCipher.encryptDeliveryTarget(destroyEmail);

    const orderDeliveryList = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .where(`DATE_ADD(order.sendRequestAt, INTERVAL order.requestToDestroyPersonalInfoDay DAY) <= :now`, {
        now,
      })
      .andWhere('order.status = :status', { status: IOrderStatus.DELIVERY_COMPLETE })
      .andWhere('orderDelivery.deliveryTarget != :targetPhone', { targetPhone: encryptedDestroyPhoneNumber })
      .andWhere('orderDelivery.deliveryTarget != :targetEmail', { targetEmail: encryptedDestroyEmail })
      .getMany();

    const destroyEmailIdList: number[] = [];
    const destroyPhoneNumberIdList: number[] = [];
    for (const orderDelivery of orderDeliveryList) {
      if (orderDelivery.deliveryMethod === IOrderSendMethod.EMAIL) {
        destroyEmailIdList.push(orderDelivery.id);
      }
      if (
        orderDelivery.deliveryMethod === IOrderSendMethod.SMS ||
        orderDelivery.deliveryMethod === IOrderSendMethod.ALIM_TALK
      ) {
        destroyPhoneNumberIdList.push(orderDelivery.id);
      }
    }

    await this.orderDeliveryRepository.update(
      { id: In(destroyPhoneNumberIdList) },
      { deliveryTarget: encryptedDestroyPhoneNumber },
    );
    await this.orderDeliveryRepository.update(
      { id: In(destroyEmailIdList) },
      { deliveryTarget: encryptedDestroyEmail },
    );
  }

  async handleDeliveryEncourage() {
    // const now = new Date();

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
      // deliveryTarget 복호화
      let decryptedDeliveryTarget = orderDelivery.deliveryTarget;
      if (orderDelivery.deliveryTarget) {
        try {
          decryptedDeliveryTarget = this.cryptoCipher.decryptDeliveryTarget(orderDelivery.deliveryTarget);
        } catch (error) {
          this.logger.error(`Failed to decrypt deliveryTarget for orderDelivery ${orderDelivery.id}: ${error}`);
          // 복호화 실패 시 원본 데이터 사용
          decryptedDeliveryTarget = orderDelivery.deliveryTarget;
        }
      }

      const title = '미사용쿠폰발생 안내';
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
          const smsText = `미사용쿠폰발생. 뒷자리 ${orderDelivery.barCode!.slice(-4)}번. ${format(orderDelivery.expireAt!, 'yyyy/MM/dd')}일까지사용. 재발송문의 1644-3614`;
          await this.smsSend.send({
            msgType: 'M',
            to: decryptedDeliveryTarget,
            from: orderDelivery.orderProductMapping.order.fromPhoneNumber!,
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
          const fromEmail =
            orderDelivery.orderProductMapping.fromEmail ?? orderDelivery.orderProductMapping.order.fromEmail;

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
