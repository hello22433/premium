import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderEntity } from '../entity/order.entity';
import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { TestOrderDeliveryEntity } from '../entity/test.order.delivery.entity';
import { OrderProductMappingEntity } from '../entity/order.product.mapping.entity';
import { OrderController } from './api/order.controller';
import { OrderService } from './application/order.service';
import { ProductEntity } from '../entity/product.entity';
import { PartnerCompanyExternModule } from '../partner_company_extern/partner.company.extern.module';
import { UserEntity } from '../entity/user.entity';
import { UserCompanyEntity } from '../entity/user.company.entity';
import { UserDiscountEntity } from '../entity/user.discount.entity';
import { UserViewScopeEntity } from '../entity/user.view.scope.entity';
import { SsgEventEntity } from '../entity/ssg.event.entity';
import { SsgEventAmountHistoryEntity } from '../entity/ssg.event.amount.history.entity';
import { EmailSendHistoryEntity } from '../entity/email.send.history.entity';
import { UserManagementModule } from '../user_management/user.management.module';
import { SsgEventModule } from '../ssg_event/ssg.event.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { ActivityLogModule } from '../activity_log/activity.log.module';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      OrderEntity,
      UserDiscountEntity,
      OrderDeliveryEntity,
      TestOrderDeliveryEntity,
      OrderProductMappingEntity,
      ProductEntity,
      UserEntity,
      UserCompanyEntity,
      UserViewScopeEntity,
      SsgEventEntity,
      SsgEventAmountHistoryEntity,
      EmailSendHistoryEntity,
    ]),
    PartnerCompanyExternModule,
    forwardRef(() => UserManagementModule),
    SsgEventModule,
    DeliveryModule,
    ActivityLogModule,
    MailModule,
  ],
  controllers: [OrderController],
  providers: [OrderService],
})
export class OrderModule {}
