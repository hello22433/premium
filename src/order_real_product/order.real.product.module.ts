import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PartnerCompanyExternModule } from '../partner_company_extern/partner.company.extern.module';
import { UserEntity } from '../entity/user.entity';
import { OrderRealProductEntity } from '../entity/order.real.product.entity';
import { OrderRealProductController } from './api/order.real.product.controller';
import { OrderRealProductService } from './application/order.real.product.service';
import { OrderRealProductMappingEntity } from '../entity/order.real.product.mapping.entity';
import { ProductEntity } from '../entity/product.entity';
import { DeliveryModule } from '../delivery/delivery.module';
import { ActivityLogModule } from '../activity_log/activity.log.module';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([UserEntity, OrderRealProductEntity, ProductEntity, OrderRealProductMappingEntity]),
    PartnerCompanyExternModule,
    DeliveryModule,
    ActivityLogModule,
  ],
  controllers: [OrderRealProductController],
  providers: [OrderRealProductService],
})
export class OrderRealProductModule {}
