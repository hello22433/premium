import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  OrderReceiveAlimTalkReqDto,
  OrderReceiveEmailReqDto,
  OrderReceiveSendToMMsEmailReqDto,
} from '../api/order.receive.req.dto';
import { OrderReceiveAlimTalkResDto, OrderReceiveEmailResDto } from '../api/order.receive.res.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { OrderEntity } from '../../entity/order.entity';
import { Repository } from 'typeorm';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderEncryptKey } from '../interface/order.encrypt.key';
import { EmailSendHistoryEntity } from '../../entity/email.send.history.entity';
import { OrderSendEncryptKey } from '../interface/order.send.encrypt.key';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { OrderReceiveSmsTemplate } from '../domain/order.receive.sms.template';
import { ISmsSend } from '../../sms/interface/sms.send';
import { defaultFromPhoneNumber } from '../../const';
import { OrderDeliveryEmailCouponStatus } from '../../delivery/interface/order.delivery.email.coupon.status';
import { Transactional } from 'typeorm-transactional';

@Injectable()
export class OrderReceiveService {
  constructor(
    private cryptoCipher: CryptoCipher,
    @InjectRepository(OrderEntity)
    private orderRepository: Repository<OrderEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
    @InjectRepository(EmailSendHistoryEntity)
    private emailSendHistoryRepository: Repository<EmailSendHistoryEntity>,
    @Inject('ISmsSend')
    private smsSend: ISmsSend,
  ) {}

  async alimTalk(getQuery: OrderReceiveAlimTalkReqDto): Promise<OrderReceiveAlimTalkResDto> {
    const orderDecrypt = this.cryptoCipher.decryptJson(getQuery.encryptKey) as OrderEncryptKey;

    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .where('orderDelivery.id = :id', { id: orderDecrypt.id })
      .getOne();

    if (!orderDelivery) {
      throw new BadRequestException('존재하지 않는 주문 정보입니다.');
    }

    if (orderDelivery.deliveryTarget !== getQuery.phoneNumber) {
      throw new BadRequestException('전화번호가 일치하지 않습니다.');
    }
    let text = orderDelivery.orderProductMapping.order.sendContent;

    if (orderDelivery.orderProductMapping.order.sendTailText) {
      text += orderDelivery.orderProductMapping.order.sendTailText;
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

    return {
      topImagePath: orderDelivery.orderProductMapping.topImagePath,
      midImagePath: orderDelivery.orderProductMapping.midImagePath,
      fromPhoneNumber: orderDelivery.orderProductMapping.order.fromPhoneNumber!,
      productName: orderDelivery.orderProductMapping.product.name,
      productImagePath: orderDelivery.orderProductMapping.product.imagePath,
      brandName: orderDelivery.orderProductMapping.product.brand!.nameKorean,
      barCode: orderDelivery.barCode!,
      couponStatus: orderDelivery.couponStatus,
      context: text,
    };
  }

  async email(getQuery: OrderReceiveEmailReqDto): Promise<OrderReceiveEmailResDto> {
    const orderDecrypt = this.cryptoCipher.decryptJson(getQuery.encryptKey) as OrderEncryptKey;

    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .where('orderDelivery.id = :id', { id: orderDecrypt.id })
      .getOne();
    if (!orderDelivery) {
      throw new BadRequestException('존재하지 않는 주문 정보입니다.');
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

    if (emailSendHistory.expireAt < new Date()) {
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
    } as OrderSendEncryptKey);

    return {
      productName: orderDelivery.orderProductMapping.product.name,
      productImagePath: orderDelivery.orderProductMapping.product.imagePath,
      sendEncryptKey: sendEncryptKey,
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

    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .where('orderDelivery.id = :id', { id: obj.orderDeliveryId })
      .getOne();
    if (!orderDelivery) {
      throw new BadRequestException('존재하지 않는 주문 정보입니다.');
    }

    if (!obj.emailSendHistoryId) {
      throw new BadRequestException('올바른 요청이 아닙니다.');
    }

    if (orderDelivery.emailCouponStatus === OrderDeliveryEmailCouponStatus.SEND) {
      throw new BadRequestException('이미 전송한 쿠폰입니다.');
    }

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

    const title = orderDelivery.orderProductMapping.order.sendTitle;
    const filePathList = [];
    if (orderDelivery.imagePath) {
      filePathList.push(orderDelivery.imagePath);
    }

    const text = OrderReceiveSmsTemplate(orderDelivery);

    let status = IOrderDeliveryStatus.COMPLETE;
    let emailCouponStatus = OrderDeliveryEmailCouponStatus.SEND;
    try {
      await this.smsSend.send({
        msgType: 'M',
        to: getBody.phoneNumber,
        from: defaultFromPhoneNumber,
        subject: title,
        text: text,
        filePath: filePathList,
      });
    } catch (e) {
      status = IOrderDeliveryStatus.FAIL;
      emailCouponStatus = OrderDeliveryEmailCouponStatus.NOT_SEND;
    } finally {
      await this.orderDeliveryRepository.update(orderDelivery.id, {
        status: status,
        emailCouponStatus: emailCouponStatus,
      });
    }

    return;
  }
}
