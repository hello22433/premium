import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OrderEntity } from '../entity/order.entity';
import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { OrderProductMappingEntity } from '../entity/order.product.mapping.entity';
import { ProductEntity } from '../entity/product.entity';
import { UserEntity } from '../entity/user.entity';
import { DeliverySendHistoryEntity } from '../entity/delivery.send.history.entity';

import { ExternalApiController } from './api/external.api.controller';
import { ExternalApiService } from './application/external.api.service';
import { ApiKeyGuard } from './api/external.api.key.guard';

import { PartnerCompanyExternModule } from '../partner_company_extern/partner.company.extern.module';
import { SsgEventModule } from '../ssg_event/ssg.event.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { CryptoCipher } from '../common/infra/crypto.cipher';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OrderEntity,
      OrderDeliveryEntity,
      OrderProductMappingEntity,
      ProductEntity,
      UserEntity,
      DeliverySendHistoryEntity,
    ]),
    PartnerCompanyExternModule,
    SsgEventModule,
    DeliveryModule,
  ],
  controllers: [ExternalApiController],
  providers: [ExternalApiService, ApiKeyGuard, CryptoCipher],
})
export class ExternalApiModule {}
