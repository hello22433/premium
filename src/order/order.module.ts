import { forwardRef, Module } from '@nestjs/common';
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
import { UserDiscountEntity } from '../entity/user.discount.entity';
import { SsgEventEntity } from '../entity/ssg.event.entity';
import { SsgEventAmountHistoryEntity } from '../entity/ssg.event.amount.history.entity';
import { UserManagementModule } from '../user_management/user.management.module';
import { SsgEventModule } from '../ssg_event/ssg.event.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { ActivityLogModule } from '../activity_log/activity.log.module';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      OrderEntity,
      UserDiscountEntity,
      OrderDeliveryEntity,
      OrderProductMappingEntity,
      ProductEntity,
      UserEntity,
      SsgEventEntity,
      SsgEventAmountHistoryEntity,
    ]),
    PartnerCompanyExternModule,
    forwardRef(() => UserManagementModule),
    SsgEventModule,
    DeliveryModule,
    ActivityLogModule,
  ],
  controllers: [OrderController],
  providers: [OrderService],
})
export class OrderModule {}
