import { Inject, Injectable } from '@nestjs/common';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeliveryAlimTalk } from '../interface/delivery.alim.talk';
import { IOrderDeliveryStatus } from '../interface/order.delivery.status';
import { IMailSend } from '../../mail/interface/mail-send';
import { IOrderSendMethod } from '../../order/interface/order.send.method';
import { DeliverySendHistoryEntity } from '../../entity/delivery.send.history.entity';

@Injectable()
export class DeliveryBatchService {
  constructor(
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
    @InjectRepository(DeliverySendHistoryEntity)
    private deliverySendHistoryRepository: Repository<DeliverySendHistoryEntity>,
    @Inject('DeliveryAlimTalk')
    private deliveryAlimTalk: DeliveryAlimTalk,
    @Inject('IMailSend')
    private mailSend: IMailSend,
    // @Inject('ISmsSend')
    // private smsSend: ISmsSend,
  ) {}

  async issueAndSend() {
    // 현재 이전 시간에 대기중인 모든 쿠폰 발행 및 발송 진행
    const now = new Date();
    const queryBuilder = this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .where('orderDelivery.sendRequestAt < :now', { now })
      .andWhere('orderDelivery.status = :status', { status: 'WAIT' });

    const orderDeliveryList = await queryBuilder.getMany();

    // 0. 전송 history 생성 entity list
    const deliveryHistoryList: DeliverySendHistoryEntity[] = [];

    // 1. 알림톡, SMS, 이메일 전송
    for (const orderDelivery of orderDeliveryList) {
      const title = orderDelivery.orderProductMapping.order.sendTitle;
      const filePathList = [];
      if (orderDelivery.imagePath) {
        filePathList.push(orderDelivery.imagePath);
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

      const deliveryMethod = orderDelivery.deliveryMethod;
      const deliveryHistory = new DeliverySendHistoryEntity();

      deliveryHistory.context = '{}';
      deliveryHistory.isSuccess = true;
      deliveryHistory.target = orderDelivery.deliveryTarget;

      // 1.1 알림톡일 경우
      if (deliveryMethod === IOrderSendMethod.ALIM_TALK) {
        try {
          const { responseData, report } = await this.deliveryAlimTalk.send({
            to: orderDelivery.deliveryTarget,
            text,
          });
          deliveryHistory.context = JSON.stringify(responseData);
          deliveryHistory.etcContext = JSON.stringify(report);
          orderDelivery.status = IOrderDeliveryStatus.COMPLETE;
        } catch (e) {
          deliveryHistory.context = JSON.stringify(e);
          deliveryHistory.isSuccess = false;
          // const resultSms = await this.handleAlimTalkFail(orderDelivery, title, text, filePathList);
          // // 문자 전송성공한 경우
          // if (resultSms === IOrderDeliveryStatus.COMPLETE_SMS) {
          //   deliveryHistory.isSuccess = true;
          // }
          // // 문자 전송도 실패한 경우
          // if (resultSms !== IOrderDeliveryStatus.COMPLETE_SMS) {
          //   deliveryHistory.context += JSON.stringify(resultSms);
          // }
        }
      }

      // 1.2 SMS 일 경우
      // if (deliveryMethod === IOrderSendMethod.SMS) {
      //   try {
      //     await this.smsSend.send({
      //       msgType: 'L',
      //       to: orderDelivery.deliveryTarget,
      //       from: orderDelivery.orderProductMapping.order.fromPhoneNumber,
      //       subject: title,
      //       text: text,
      //       filePath: filePathList,
      //     });
      //     orderDelivery.status = IOrderDeliveryStatus.COMPLETE;
      //   } catch (e) {
      //     orderDelivery.status = IOrderDeliveryStatus.FAIL;
      //     deliveryHistory.context = JSON.stringify(e);
      //     deliveryHistory.isSuccess = false;
      //   }
      // }

      // 1.3 EMAIL 일 경우
      if (deliveryMethod === IOrderSendMethod.EMAIL) {
        try {
          await this.mailSend.send({
            saveSendMail: 'Y',
            bcc: '',
            cc: '',
            content: text,
            subject: title,
            to: orderDelivery.deliveryTarget,
          });
          orderDelivery.status = IOrderDeliveryStatus.COMPLETE;
        } catch (e) {
          orderDelivery.status = IOrderDeliveryStatus.FAIL;
          deliveryHistory.context = JSON.stringify(e);
          deliveryHistory.isSuccess = false;
        }
      }
      deliveryHistoryList.push(deliveryHistory);
      await this.orderDeliveryRepository.save(orderDelivery);
    }

    await this.deliverySendHistoryRepository.insert(deliveryHistoryList);

    return;
  }

  // private async handleAlimTalkFail(
  //   orderDelivery: OrderDeliveryEntity,
  //   title: string,
  //   text: string,
  //   filePathList: string[],
  // ) {
  //   try {
  //     await this.smsSend.send({
  //       msgType: 'L',
  //       to: orderDelivery.deliveryTarget,
  //       from: orderDelivery.orderProductMapping.order.fromPhoneNumber,
  //       subject: title,
  //       text: text,
  //       filePath: filePathList,
  //     });
  //     orderDelivery.status = IOrderDeliveryStatus.COMPLETE_SMS;
  //     return IOrderDeliveryStatus.COMPLETE_SMS;
  //   } catch (e) {
  //     orderDelivery.status = IOrderDeliveryStatus.FAIL_SMS;
  //     return e;
  //   }
  // }
}
