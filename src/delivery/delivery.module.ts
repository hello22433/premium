import { Module } from '@nestjs/common';
import { DeliveryAlimTalkInfoBankHttp } from './infra/delivery.alim.talk.info.bank.http';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeliverySendHistoryEntity } from '../entity/delivery.send.history.entity';
import { DeliveryBatchService } from './application/delivery.batch.service';
import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { DeliveryBatchSchedule } from './delivery.batch.schedule';
import { MailModule } from '../mail/mail.module';
import { SmsModule } from '../sms/sms.module';
import { OrderEntity } from '../entity/order.entity';
import { AuthModule } from '../auth/auth.module';
import { EmailSendHistoryEntity } from '../entity/email.send.history.entity';
import { FileModule } from '../file/file.module';
import { DeliveryTrackHttp } from './infra/delivery.track.http';
import { OrderRealProductEntity } from '../entity/order.real.product.entity';
import { OrderRealProductMappingEntity } from '../entity/order.real.product.mapping.entity';

@Module({
  imports: [
    AuthModule,
    HttpModule,
    TypeOrmModule.forFeature([
      OrderEntity,
      OrderDeliveryEntity,
      OrderRealProductEntity,
      OrderRealProductMappingEntity,
      DeliverySendHistoryEntity,
      EmailSendHistoryEntity,
    ]),
    MailModule,
    SmsModule,
    FileModule,
  ],
  providers: [
    {
      provide: 'DeliveryAlimTalk',
      useClass: DeliveryAlimTalkInfoBankHttp,
    },
    DeliveryTrackHttp,
    DeliveryBatchService,
    DeliveryBatchSchedule,
  ],
  exports: [
    {
      provide: 'DeliveryAlimTalk',
      useClass: DeliveryAlimTalkInfoBankHttp,
    },
    DeliveryTrackHttp,
    DeliveryBatchService,
  ],
})
export class DeliveryModule {}
