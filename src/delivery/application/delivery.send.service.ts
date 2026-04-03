import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { addDays, format } from 'date-fns';
import * as QRCode from 'qrcode';

import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { DeliverySendHistoryEntity } from '../../entity/delivery.send.history.entity';
import { EmailSendHistoryEntity } from '../../entity/email.send.history.entity';

import { DeliveryAlimTalk } from '../interface/delivery.alim.talk';
import { IOrderDeliveryStatus } from '../interface/order.delivery.status';
import { IMailSend } from '../../mail/interface/mail-send';
import { ISmsSend } from '../../sms/interface/sms.send';
import { IOrderType } from '../../order/interface/order.type';
import { IProductType } from '../../product/interface/product.type';
import { IFileStorage } from '../../file/interface/file.storage';

import { AlimTalkTemplate } from '../domain/alim.talk.template';
import { SmsChoiceProductTemplate } from '../domain/sms.choice.product.template';
import { smsCouponInfoTemplate } from '../domain/sms.coupon.info.template';
import { smsSsgTemplate } from '../domain/sms.ssg.template';
import { EmailDeliveryTemplate } from '../domain/email.delivery.template';
import { OrderEmailSendType } from '../../order/domain/order.email.send.type';
import { EmailType } from '../../mail/domain/email.type';
import { EmailCertifyExpireDay } from '../../const';

import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { OrderEncryptKey } from '../../order_receive/interface/order.encrypt.key';
import { generateRandomCode } from '../../user_find/domain/code.generate';

@Injectable()
export class DeliverySendService {
  private readonly logger = new Logger('delivery-send');

  constructor(
    @Inject('DeliveryAlimTalk')
    private deliveryAlimTalk: DeliveryAlimTalk,
    @Inject('IMailSend')
    private mailSend: IMailSend,
    @Inject('ISmsSend')
    private smsSend: ISmsSend,
    private cryptoCipher: CryptoCipher,
    private configService: ConfigService,
    @InjectRepository(EmailSendHistoryEntity)
    private emailSendHistoryRepository: Repository<EmailSendHistoryEntity>,
    @Inject('IFileStorage')
    private fileStorage: IFileStorage,
  ) {}

  /**
   * 발송 성공 시 actualSendAt 설정
   */
  markSendSuccess(orderDelivery: OrderDeliveryEntity, status: IOrderDeliveryStatus): void {
    orderDelivery.status = status;
    if (!orderDelivery.actualSendAt) {
      orderDelivery.actualSendAt = new Date();
    }
  }

  /**
   * 발송 실패 시 failedAt 설정
   */
  markSendFail(orderDelivery: OrderDeliveryEntity, status: IOrderDeliveryStatus): void {
    orderDelivery.status = status;
    if (!orderDelivery.failedAt) {
      orderDelivery.failedAt = new Date();
    }
  }

  /**
   * SMS 발송 텍스트 구성 (SSG 템플릿 + 초이스 쿠폰 URL 적용)
   */
  buildSmsText(orderDelivery: OrderDeliveryEntity, encryptKey: string, text: string): string {
    const orderType = orderDelivery.orderProductMapping.order.type;
    const productType = orderDelivery.orderProductMapping.product.type;

    let smsText = text;
    smsText = SmsChoiceProductTemplate(
      orderDelivery,
      `${this.configService.getOrThrow('SMS_CHOICE_URL')}/${encryptKey}`,
      smsText,
    );

    // SSG 상품: 쿠폰번호, 인증번호, 교환처 등 상세 정보 추가
    if (orderType === IOrderType.SSG) {
      smsText += smsSsgTemplate(orderDelivery);
    }

    // 비SSG, 비초이스 상품에 쿠폰 정보를 본문 앞에 배치 (barCode가 있는 경우만)
    if (orderType !== IOrderType.SSG && productType !== IProductType.CHOICE && orderDelivery.barCode) {
      smsText = smsCouponInfoTemplate(orderDelivery) + '\n\n' + smsText;
    }

    // 선택 완료된 초이스쿠폰: 선택된 상품의 쿠폰 정보를 앞에 배치
    if (productType === IProductType.CHOICE && orderDelivery.choiceSelectProductId && orderDelivery.barCode) {
      const brand = orderDelivery.choiceSelectProduct?.brand ?? orderDelivery.orderProductMapping.product.brand;
      const brandName = brand?.nameKorean ?? '';
      const formattedExpireAt = orderDelivery.expireAt ? format(orderDelivery.expireAt, 'yyyy.MM.dd') : '';
      const couponHeader = `쿠폰번호 : ${orderDelivery.barCode}\n유효기간 : ~ ${formattedExpireAt}\n사용처 : ${brandName}\n고객센터 : 1644-3614`;
      smsText = couponHeader + '\n\n' + smsText;
    }

    return smsText;
  }

  /**
   * 알림톡 발송
   */
  async sendAlimTalk(
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

  /**
   * SMS 발송
   */
  async sendSms(
    orderDelivery: OrderDeliveryEntity,
    decryptedDeliveryTarget: string,
    encryptKey: string,
    title: string,
    text: string,
    filePathList: string[],
    deliveryHistory: DeliverySendHistoryEntity,
  ): Promise<void> {
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

  /**
   * 이메일 발송
   */
  async sendEmail(
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
      this.markSendSuccess(orderDelivery, IOrderDeliveryStatus.COMPLETE);
      deliveryHistory.context = text;
    } catch (e) {
      this.markSendFail(orderDelivery, IOrderDeliveryStatus.FAIL);
      deliveryHistory.context = JSON.stringify(e);
      deliveryHistory.isSuccess = false;
    }
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
}
