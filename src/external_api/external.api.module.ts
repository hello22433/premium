import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';

import { OrderEntity } from '../entity/order.entity';
import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { OrderProductMappingEntity } from '../entity/order.product.mapping.entity';
import { ProductEntity } from '../entity/product.entity';
import { UserEntity } from '../entity/user.entity';
import { DeliverySendHistoryEntity } from '../entity/delivery.send.history.entity';
import { UserSyncProductEventMappingEntity } from '../entity/user.sync.product.event.mapping.entity';
import { IdempotencyKeyEntity } from '../entity/idempotency.key.entity';
import { ExternalApiAccountEntity } from '../entity/external.api.account.entity';
import { ExternalApiAllowedIpEntity } from '../entity/external.api.allowed.ip.entity';
import { UserDiscountEntity } from '../entity/user.discount.entity';

import { ExternalApiController } from './api/external.api.controller';
import { ExternalApiService } from './application/external.api.service';
import { ApiKeyGuard } from './api/external.api.key.guard';
import { ExternalApiThrottleGuard } from './api/external.api.throttle.guard';
import { IdempotencyInterceptor } from './api/idempotency.interceptor';

import { PartnerCompanyExternModule } from '../partner_company_extern/partner.company.extern.module';
import { SsgEventModule } from '../ssg_event/ssg.event.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { ProductModule } from '../product/product.module';
import { CryptoCipher } from '../common/infra/crypto.cipher';
import { AccountLifecycleModule } from '../account_lifecycle/account.lifecycle.module';
import { OrderFromModule } from '../order_from/order.from.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OrderEntity,
      OrderDeliveryEntity,
      OrderProductMappingEntity,
      ProductEntity,
      UserEntity,
      DeliverySendHistoryEntity,
      UserSyncProductEventMappingEntity,
      IdempotencyKeyEntity,
      ExternalApiAccountEntity,
      ExternalApiAllowedIpEntity,
      UserDiscountEntity,
    ]),
    ThrottlerModule.forRoot([
      {
        ttl: 60000, // 1분
        limit: 60, // API Key당 분당 60회
      },
    ]),
    PartnerCompanyExternModule,
    SsgEventModule,
    DeliveryModule,
    ProductModule,
    AccountLifecycleModule,
    OrderFromModule,
  ],
  controllers: [ExternalApiController],
  providers: [ExternalApiService, ApiKeyGuard, ExternalApiThrottleGuard, IdempotencyInterceptor, CryptoCipher],
})
export class ExternalApiModule {}
