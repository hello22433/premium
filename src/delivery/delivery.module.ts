import { Module } from '@nestjs/common';
import { DeliveryAlimTalkInfoBankHttp } from './infra/delivery.alim.talk.info.bank.http';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeliverySendHistoryEntity } from '../entity/delivery.send.history.entity';
import { DeliveryBatchService } from './application/delivery.batch.service';
import { DeliverySendService } from './application/delivery.send.service';
import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { OrderDeliveryRefundEntity } from '../entity/order.delivery.refund.entity';
import { DeliveryBatchSchedule } from './delivery.batch.schedule';
import { RefundLedgerService } from './application/refund-ledger.service';
import { SsgRefundResolverService } from './application/ssg-refund.resolver';
import { SsgInsertStateModule } from './ssg.insert.state.module';
import { MailModule } from '../mail/mail.module';
import { SmsModule } from '../sms/sms.module';
import { OrderEntity } from '../entity/order.entity';
import { AuthModule } from '../auth/auth.module';
import { EmailSendHistoryEntity } from '../entity/email.send.history.entity';
import { FileModule } from '../file/file.module';
import { DeliveryTrackHttp } from './infra/delivery.track.http';
import { OrderRealProductEntity } from '../entity/order.real.product.entity';
import { OrderRealProductMappingEntity } from '../entity/order.real.product.mapping.entity';
import { UserEntity } from '../entity/user.entity';
import { SsgEventEntity } from '../entity/ssg.event.entity';
import { SsgIssueLogEntity } from '../entity/ssg.issue.log.entity';
import { PartnerCompanyExternModule } from '../partner_company_extern/partner.company.extern.module';
import { SsgEventModule } from '../ssg_event/ssg.event.module';
import { UserManagementModule } from '../user_management/user.management.module';

@Module({
  imports: [
    AuthModule,
    HttpModule.register({ timeout: 30000 }),
    TypeOrmModule.forFeature([
      OrderEntity,
      OrderDeliveryEntity,
      OrderDeliveryRefundEntity,
      OrderRealProductEntity,
      OrderRealProductMappingEntity,
      DeliverySendHistoryEntity,
      EmailSendHistoryEntity,
      UserEntity,
      SsgEventEntity,
      SsgIssueLogEntity,
    ]),
    MailModule,
    SmsModule,
    FileModule,
    PartnerCompanyExternModule,
    SsgEventModule,
    UserManagementModule,
    SsgInsertStateModule,
  ],
  providers: [
    {
      provide: 'DeliveryAlimTalk',
      useClass: DeliveryAlimTalkInfoBankHttp,
    },
    DeliveryTrackHttp,
    DeliverySendService,
    DeliveryBatchService,
    DeliveryBatchSchedule,
    RefundLedgerService,
    SsgRefundResolverService,
  ],
  exports: [
    {
      provide: 'DeliveryAlimTalk',
      useClass: DeliveryAlimTalkInfoBankHttp,
    },
    DeliveryTrackHttp,
    DeliverySendService,
    DeliveryBatchService,
    RefundLedgerService,
    SsgRefundResolverService,
    SsgInsertStateModule,
  ],
})
export class DeliveryModule {}
