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
import { GemteckMsgQueueEntity } from 'src/entity/gemtek/msg.queue.entity';
import { SmsModule } from 'src/sms/sms.module';
import { ActivityLogModule } from 'src/activity_log/activity.log.module';
import { UserEntity } from 'src/entity/user.entity';
import { UserCompanyEntity } from 'src/entity/user.company.entity';
import { UserTaskHistoryEntity } from 'src/entity/user.task.history.entity';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [
    AuthModule,
    WalletModule,
    TypeOrmModule.forFeature([
      OrderEntity,
      OrderDeliveryEntity,
      OrderProductMappingEntity,
      OrderHistoryEntity,
      GemteckMsgQueueEntity,
      UserEntity,
      UserCompanyEntity,
      UserTaskHistoryEntity,
    ]),
    PartnerCompanyExternModule,
    DeliveryModule,
    SmsModule,
    ActivityLogModule,
  ],
  controllers: [CustomerServiceController],
  providers: [CustomerServiceService],
})
export class CustomerServiceModule {}
