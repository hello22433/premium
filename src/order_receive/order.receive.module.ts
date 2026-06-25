import { Module } from '@nestjs/common';
import { OrderReceiveController } from './api/order.receive.controller';
import { OrderReceiveService } from './application/order.receive.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { TestOrderDeliveryEntity } from '../entity/test.order.delivery.entity';
import { OrderEntity } from '../entity/order.entity';
import { SmsModule } from '../sms/sms.module';
import { EmailSendHistoryEntity } from '../entity/email.send.history.entity';
import { ProductChoiceMappingEntity } from '../entity/product.choice.mapping.entity';
import { SsgEventEntity } from '../entity/ssg.event.entity';
import { PartnerCompanyExternModule } from '../partner_company_extern/partner.company.extern.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { OrderFromModule } from '../order_from/order.from.module';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      EmailSendHistoryEntity,
      OrderDeliveryEntity,
      TestOrderDeliveryEntity,
      OrderEntity,
      ProductChoiceMappingEntity,
      SsgEventEntity,
    ]),
    SmsModule,
    PartnerCompanyExternModule,
    DeliveryModule,
    OrderFromModule,
  ],
  controllers: [OrderReceiveController],
  providers: [OrderReceiveService],
})
export class OrderReceiveModule {}
