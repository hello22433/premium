import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { ExternalApiAccountEntity } from '../../entity/external.api.account.entity';
import { ExternalApiWebhookLogEntity } from '../../entity/external.api.webhook.log.entity';

import { AuthModule } from '../../auth/auth.module';
import { OrderDeliveryCancelSubscriber } from './order.delivery.cancel.subscriber';
import { CouponCancelWebhookSender } from './coupon.cancel.webhook.sender';
import { CouponCancelWebhookListener } from './coupon.cancel.webhook.listener';
import { CancelWebhookAdminService } from './cancel.webhook.admin.service';
import { CancelWebhookAdminController } from './cancel.webhook.admin.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([OrderDeliveryEntity, ExternalApiAccountEntity, ExternalApiWebhookLogEntity]),
    HttpModule.register({ timeout: 10_000 }),
    AuthModule,
  ],
  controllers: [CancelWebhookAdminController],
  providers: [
    OrderDeliveryCancelSubscriber,
    CouponCancelWebhookSender,
    CouponCancelWebhookListener,
    CancelWebhookAdminService,
  ],
})
export class ExternalApiWebhookModule {}
