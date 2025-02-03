import { Module } from '@nestjs/common';
import { DeliveryAlimTalkInfoBankHttp } from './infra/delivery.alim.talk.info.bank.http';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeliverySendHistoryEntity } from '../entity/delivery.send.history.entity';
import { DeliveryBatchService } from './application/delivery.batch.service';
import { CryptoCipher } from '../common/infra/crypto.cipher';
import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { DeliveryBatchSchedule } from './delivery.batch.schedule';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [
    HttpModule,
    TypeOrmModule.forFeature([OrderDeliveryEntity, DeliverySendHistoryEntity]),
    MailModule,
    // SmsModule,
  ],
  providers: [
    {
      provide: 'DeliveryAlimTalk',
      useClass: DeliveryAlimTalkInfoBankHttp,
    },
    DeliveryBatchService,
    DeliveryBatchSchedule,
    CryptoCipher,
  ],
  exports: [
    {
      provide: 'DeliveryAlimTalk',
      useClass: DeliveryAlimTalkInfoBankHttp,
    },
  ],
})
export class DeliveryModule {}
