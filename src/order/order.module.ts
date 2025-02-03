import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderEntity } from '../entity/order.entity';
import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { OrderProductMappingEntity } from '../entity/order.product.mapping.entity';
import { OrderController } from './api/order.controller';
import { OrderService } from './application/order.service';
import { ProductEntity } from '../entity/product.entity';
import { PartnerCompanyExternModule } from '../partner_company_extern/partner.company.extern.module';
import { UserEntity } from '../entity/user.entity';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([OrderEntity, OrderDeliveryEntity, OrderProductMappingEntity, ProductEntity, UserEntity]),
    PartnerCompanyExternModule,
  ],
  controllers: [OrderController],
  providers: [OrderService],
})
export class OrderModule {}
