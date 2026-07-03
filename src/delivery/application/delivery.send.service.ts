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
import {
  IOrderDeliveryReportState,
  REPORT_DEADLINE_MS,
  REPORT_NEXT_DUE_MS,
} from '../interface/order.delivery.report.state';
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
import { couponTokenExpiry } from '../../common/utils/expire.util';
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
   * SMS 발송 텍스트 구성
   * 순서: body(발신내용) → 핀번호/유효기간 → memo(상품유의사항) → tailText(꼬리 광고)
   */
  buildSmsText(
    orderDelivery: OrderDeliveryEntity,
    encryptKey: string,
    body: string,
    memo?: string | null,
    tailText?: string | null,
  ): string {
    const orderType = orderDelivery.orderProductMapping.order.type;
    const productType = orderDelivery.orderProductMapping.product.type;

    let smsText = SmsChoiceProductTemplate(
      orderDelivery,
      `${this.configService.getOrThrow('SMS_CHOICE_URL')}/${encryptKey}`,
      body,
    );

    // SSG 상품: 쿠폰번호, 인증번호, 교환처 등 상세 정보 추가
    if (orderType === IOrderType.SSG) {
      smsText += smsSsgTemplate(orderDelivery);
    }

    // 비SSG, 비초이스 상품에 쿠폰 정보를 본문 뒤에 배치 (barCode가 있는 경우만)
    if (orderType !== IOrderType.SSG && productType !== IProductType.CHOICE && orderDelivery.barCode) {
      smsText += '\n\n' + smsCouponInfoTemplate(orderDelivery);
    }

    // 선택 완료된 초이스쿠폰: 선택된 상품의 쿠폰 정보를 본문 뒤에 배치
    if (productType === IProductType.CHOICE && orderDelivery.choiceSelectProductId && orderDelivery.barCode) {
      const brand = orderDelivery.choiceSelectProduct?.brand ?? orderDelivery.orderProductMapping.product.brand;
      const brandName = brand?.nameKorean ?? '';
      const formattedExpireAt = orderDelivery.expireAt ? format(orderDelivery.expireAt, 'yyyy.MM.dd') : '';
      const couponFooter = `쿠폰번호 : ${orderDelivery.barCode}\n유효기간 : ~ ${formattedExpireAt}\n사용처 : ${brandName}\n고객센터 : 1644-3614`;
      smsText += '\n\n' + couponFooter;
    }

    // 상품 유의사항 (핀번호/유효기간 다음 위치)
    if (memo) {
      smsText += `\n\n${memo}`;
    }

    // 꼬리 광고
    if (tailText) {
      smsText += `\n\n${tailText}`;
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
    body: string,
    memo: string | null,
    tailText: string | null,
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
      const resultSms = await this.handleAlimTalkFail(
        orderDelivery,
        title,
        body,
        memo,
        tailText,
        filePathList,
        decryptedDeliveryTarget,
        encryptKey,
      );
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
   * 알림톡 POST 수락 후 '수신확인 대기'(PENDING) 마킹. status 는 WAIT 유지(reportSweep 가 터미널 확정).
   */
  private markAlimtalkPending(orderDelivery: OrderDeliveryEntity, msgKey: string): void {
    const now = new Date();
    orderDelivery.alimTalkMsgKey = msgKey;
    orderDelivery.reportState = IOrderDeliveryReportState.PENDING;
    orderDelivery.reportNextDueAt = new Date(now.getTime() + REPORT_NEXT_DUE_MS);
    orderDelivery.reportDeadlineAt = new Date(now.getTime() + REPORT_DEADLINE_MS);
    if (!orderDelivery.actualSendAt) {
      orderDelivery.actualSendAt = now;
    }
  }

  /**
   * 알림톡 비동기 발송 (발송 배치 전용): POST 만 수행하고 reportState=PENDING 으로 마킹한다.
   * 수신확인(inquiry)·COMPLETE/정산/환불 판정은 reportSweep 가 담당한다.
   * POST 자체 실패(네트워크/거부)는 즉시 SMS 폴백(handleAlimTalkFail) — 기존 sendAlimTalk 실패경로와 동일 시맨틱.
   */
  async sendAlimTalkAsync(
    orderDelivery: OrderDeliveryEntity,
    decryptedDeliveryTarget: string,
    encryptKey: string,
    title: string,
    body: string,
    memo: string | null,
    tailText: string | null,
    filePathList: string[],
    deliveryHistory: DeliverySendHistoryEntity,
  ): Promise<void> {
    deliveryHistory.orderDeliveryId = orderDelivery.id;
    try {
      const alimTalk = AlimTalkTemplate(orderDelivery);
      const { msgKey, responseData } = await this.deliveryAlimTalk.postAlimtalk({
        to: decryptedDeliveryTarget,
        text: alimTalk,
        encryptKey: encryptKey,
      });

      deliveryHistory.context = JSON.stringify(responseData);
      deliveryHistory.isSuccess = true; // POST 수락 (최종 도달 여부는 reportSweep 가 정정)

      this.markAlimtalkPending(orderDelivery, msgKey);
    } catch (e) {
      deliveryHistory.context = JSON.stringify(e);
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
      );
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
    body: string,
    memo: string | null,
    tailText: string | null,
    filePathList: string[],
    deliveryHistory: DeliverySendHistoryEntity,
  ): Promise<void> {
    const smsText = this.buildSmsText(orderDelivery, encryptKey, body, memo, tailText);

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
      deliveryHistory.context = smsText;
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
    emailSendHistory.email = this.cryptoCipher.encryptDeliveryTarget(decryptedDeliveryTarget);
    emailSendHistory.type = EmailType.COUPON;
    emailSendHistory.code = generateRandomCode();
    emailSendHistory.expireAt = addDays(new Date(), EmailCertifyExpireDay);
    await this.emailSendHistoryRepository.save(emailSendHistory);

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
}
