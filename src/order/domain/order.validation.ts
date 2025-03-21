import { OrderEntity } from '../../entity/order.entity';
import { BadRequestException } from '@nestjs/common';
import { IOrderSendMethod } from '../interface/order.send.method';

export const OrderValidation = (order: OrderEntity) => {
  const now = new Date();

  if (!order.eventName) {
    throw new BadRequestException('이벤트 명이 존재하지 않습니다.');
  }

  if (order.sendRequestAt < now) {
    throw new BadRequestException('발송 요청 시각이 올바르지 않습니다.');
  }

  if (!order.sendTitle) {
    throw new BadRequestException('제목이 존재하지 않습니다.');
  }

  if (!order.sendContent) {
    throw new BadRequestException('내용이 존재하지 않습니다.');
  }

  for (const orderProduct of order.orderProductMappings!) {
    if (orderProduct.amount !== orderProduct.orderDeliveries.length) {
      throw new BadRequestException('상품 전송과 전송 주체의 개수가 같지 않습니다.');
    }
  }

  if (order.sendMethod === IOrderSendMethod.SMS || order.sendMethod === IOrderSendMethod.ALIM_TALK) {
    if (!order.fromPhoneNumber) {
      throw new BadRequestException('발신 번호를 입력해 주세요.');
    }
  }

  if (order.sendMethod === IOrderSendMethod.EMAIL) {
    if (!order.fromEmail) {
      throw new BadRequestException('발신 이메일을 입력해 주세요.');
    }

    if (!order.emailSendType) {
      throw new BadRequestException('QR 혹은 URL을 선택해주세요.');
    }
  }

  return;
};
