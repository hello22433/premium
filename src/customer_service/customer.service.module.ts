import { Module } from '@nestjs/common';
import { CustomerServiceController } from './api/customer.service.controller';
import { CustomerServiceService } from './application/customer.service.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderEntity } from '../entity/order.entity';
import { OrderProductMappingEntity } from '../entity/order.product.mapping.entity';
import { AuthModule } from '../auth/auth.module';
import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { PartnerCompanyExternModule } from '../partner_company_extern/partner.company.extern.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { OrderHistoryEntity } from 'src/entity/order.history.entity';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      OrderEntity, 
      OrderDeliveryEntity, 
      OrderProductMappingEntity,
      OrderHistoryEntity,
    ]),
    PartnerCompanyExternModule,
    DeliveryModule,
  ],
  controllers: [CustomerServiceController],
  providers: [CustomerServiceService],
})
export class CustomerServiceModule {}
