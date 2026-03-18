import { OrderEntity } from '../../entity/order.entity';
import { BadRequestException } from '@nestjs/common';
import { IOrderSendMethod } from '../interface/order.send.method';
import { IOrderStatus } from '../interface/order.status';

export const OrderValidation = (order: OrderEntity) => {
  // let now = new Date();
  // now = addMinutes(now, 30);

  if (!order.eventName) {
    throw new BadRequestException('이벤트 명이 존재하지 않습니다.');
  }

  // if (order.sendRequestAt < now) {
  //   throw new BadRequestException('발송 요청 시각이 현재시각 보다 30분 전으로 입력 바랍니다.');
  // }

  for (const orderProduct of order.orderProductMappings!) {
    // 각 상품별 제목/내용 검증
    if (!orderProduct.sendTitle) {
      throw new BadRequestException('제목이 존재하지 않습니다.');
    }

    if (!orderProduct.sendContent) {
      throw new BadRequestException('내용이 존재하지 않습니다.');
    }

    if (orderProduct.amount !== orderProduct.orderDeliveries.length) {
      throw new BadRequestException('상품 전송과 전송 주체의 개수가 같지 않습니다.');
    }

    if (order.status !== IOrderStatus.DELIVERY_REQUEST) {
      if (orderProduct.product.useStatus !== 'USE') {
        throw new BadRequestException('사용할 수 없는 상품이 존재합니다.');
      }
    }

    // 각 상품별 발송 방법 검증
    const sendMethod = orderProduct.sendMethod;
    if (sendMethod === IOrderSendMethod.MMS || sendMethod === IOrderSendMethod.ALIM_TALK) {
      if (!orderProduct.fromPhoneNumber) {
        throw new BadRequestException('발신 번호를 입력해 주세요.');
      }
    }

    if (sendMethod === IOrderSendMethod.EMAIL) {
      if (!orderProduct.fromEmail) {
        throw new BadRequestException('발신 이메일을 입력해 주세요.');
      }

      if (!orderProduct.emailSendType) {
        throw new BadRequestException('QR 혹은 URL을 선택해주세요.');
      }
    }
  }

  return;
};
