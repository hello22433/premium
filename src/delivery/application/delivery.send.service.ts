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
import { MessageAttemptService } from './message-attempt.service';
import { MessageAttemptChannel, MessageAttemptType } from '../interface/message.attempt.status';
import { DeliveryExclusiveOp } from '../interface/delivery.workflow.status';
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
    private messageAttemptService: MessageAttemptService,
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
    // 폴백은 "알림톡이 나가지 못했다"가 확정된 경우로만 한정한다. 도달 확정 뒤의 후속 처리 실패까지
    // 폴백으로 흘리면 같은 쿠폰이 MMS 로 중복 발송된다.
    let alimTalkDelivered = false;
    let responseContext: string | null = null;
    try {
      const alimTalk = AlimTalkTemplate(orderDelivery);
      const { responseData, report } = await this.messageAttemptService.trackAlimTalk(
        {
          orderDeliveryId: orderDelivery.id,
          slotOp: DeliveryExclusiveOp.MESSAGE_SEND,
          attemptType: MessageAttemptType.INITIAL,
          sendReason: 'COUPON',
        },
        () =>
          this.deliveryAlimTalk.send({
            to: decryptedDeliveryTarget,
            text: alimTalk,
            encryptKey: encryptKey,
          }),
        (result) => result.report.code === 'A000',
      );

      // 도달 여부는 이력 직렬화보다 **먼저** 확정한다 — JSON.stringify 예외가 폴백 경로를 여는 것을 막는다.
      alimTalkDelivered = report.code === 'A000';

      responseContext = JSON.stringify(responseData);
      deliveryHistory.context = responseContext;
      deliveryHistory.etcContext = JSON.stringify(report);

      if (!alimTalkDelivered) {
        // 실패 사유(reportCode 63018/63019/63020 등)를 message 에 실어 catch 의 이력 기록까지 전달한다.
        throw new Error(`AlimTalk Send Error: ${JSON.stringify(report)}`);
      }

      this.markSendSuccess(orderDelivery, IOrderDeliveryStatus.COMPLETE);
    } catch (e) {
      // Error 는 JSON.stringify 하면 '{}' 라 사유가 사라진다. 응답 원문이 있으면 지우지 않고 사유를 덧붙인다.
      const reason = (e as Error)?.message ?? String(e);
      deliveryHistory.context = responseContext ? `${responseContext} ${reason}` : reason;

      if (alimTalkDelivered) {
        // 알림톡은 이미 고객에게 도달했다 — 여기서 폴백하면 MMS 중복 발송이다.
        // 발송 판정은 유지하고 후속 처리 실패만 남긴다.
        this.logger.error(`알림톡 도달 후 후속 처리 실패(폴백 없음). orderDeliveryId=${orderDelivery.id}: ${reason}`);
        return;
      }

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
    // 동기 경로와 동일 — POST 수락(msgKey 확보) 이후의 예외는 폴백 대상이 아니다(MMS 중복 발송 차단).
    let alimTalkAccepted = false;
    let responseContext: string | null = null;
    try {
      const alimTalk = AlimTalkTemplate(orderDelivery);
      const { msgKey, responseData } = await this.messageAttemptService.trackAlimTalk(
        {
          orderDeliveryId: orderDelivery.id,
          slotOp: DeliveryExclusiveOp.MESSAGE_SEND,
          attemptType: MessageAttemptType.INITIAL,
          sendReason: 'COUPON',
          // POST 수락은 접수일 뿐 — 최종 도달은 reportSweep 가 확정한다(TRACKING 유지).
          awaitsReport: true,
        },
        () =>
          this.deliveryAlimTalk.postAlimtalk({
            to: decryptedDeliveryTarget,
            text: alimTalk,
            encryptKey: encryptKey,
          }),
        // POST 수락(msgKey 확보)은 접수 성공이며 최종 도달은 reportSweep 가 확정한다 → 미확정(TRACKING).
        (result) => !!result.msgKey,
      );

      // POST 수락 여부를 이력 직렬화보다 먼저 확정한다(동기 경로와 동일 이유).
      alimTalkAccepted = true;

      responseContext = JSON.stringify(responseData);
      deliveryHistory.context = responseContext;
      deliveryHistory.isSuccess = true; // POST 수락 (최종 도달 여부는 reportSweep 가 정정)

      this.markAlimtalkPending(orderDelivery, msgKey);
    } catch (e) {
      // Error 는 JSON.stringify 하면 '{}' 라 사유가 사라진다. 응답 원문이 있으면 지우지 않고 사유를 덧붙인다.
      const reason = (e as Error)?.message ?? String(e);
      deliveryHistory.context = responseContext ? `${responseContext} ${reason}` : reason;

      if (alimTalkAccepted) {
        // POST 는 이미 수락됐다(발송 진행 중) — 폴백하면 MMS 중복 발송이다.
        // 최종 도달 판정은 reportSweep 가 하므로 여기서는 후속 처리 실패만 남긴다.
        this.logger.error(
          `알림톡 POST 수락 후 후속 처리 실패(폴백 없음). orderDeliveryId=${orderDelivery.id}: ${reason}`,
        );
        return;
      }

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
      await this.messageAttemptService.trackSend(
        {
          orderDeliveryId: orderDelivery.id,
          slotOp: DeliveryExclusiveOp.MESSAGE_SEND,
          channel: MessageAttemptChannel.MMS,
          attemptType: MessageAttemptType.INITIAL,
          sendReason: 'COUPON',
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
    slotOp: DeliveryExclusiveOp = DeliveryExclusiveOp.MESSAGE_SEND,
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
}
