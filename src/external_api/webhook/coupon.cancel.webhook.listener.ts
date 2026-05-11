import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { ExternalApiAccountEntity } from '../../entity/external.api.account.entity';
import { COUPON_CANCELLED_EVENT, CouponCancelledEventPayload } from './coupon.cancelled.event';
import { CouponCancelWebhookSender } from './coupon.cancel.webhook.sender';

@Injectable()
export class CouponCancelWebhookListener {
  private readonly logger = new Logger(CouponCancelWebhookListener.name);

  constructor(
    @InjectRepository(OrderDeliveryEntity)
    private readonly orderDeliveryRepository: Repository<OrderDeliveryEntity>,
    @InjectRepository(ExternalApiAccountEntity)
    private readonly accountRepository: Repository<ExternalApiAccountEntity>,
    private readonly sender: CouponCancelWebhookSender,
  ) {}

  @OnEvent(COUPON_CANCELLED_EVENT, { async: true })
  async handle(event: CouponCancelledEventPayload): Promise<void> {
    try {
      const orderDelivery = await this.orderDeliveryRepository.findOne({
        where: { id: event.orderDeliveryId },
        relations: { orderProductMapping: { order: true } },
      });
      if (!orderDelivery) return;

      const externalTrId = orderDelivery.externalTrId;
      if (!externalTrId) return; // 외부 API 주문이 아님

      const userId = orderDelivery.orderProductMapping?.order?.userId;
      if (!userId) return;

      const account = await this.accountRepository.findOne({ where: { userId } });
      if (!account) return;
      if (!account.cancelWebhookEnabled || !account.cancelWebhookUrl) return;

      await this.sender.send(account, orderDelivery.id, {
        trId: externalTrId,
        couponStatus: event.couponStatus,
        cancelledAt: event.cancelledAt,
      });
    } catch (err) {
      this.logger.error(`webhook handler failed for orderDelivery ${event.orderDeliveryId}`, err);
    }
  }
}
