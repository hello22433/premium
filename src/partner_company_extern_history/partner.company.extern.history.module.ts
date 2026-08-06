import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PartnerCompanyExternHistoryEntity } from '../entity/partner.company.extern.history.entity';
import { PartnerCompanyExternHistoryService } from './application/partner.company.extern.history.service';
import { PartnerCompanyExternHistoryController } from './api/partner.company.extern.history.controller';
import { AuthModule } from '../auth/auth.module';
import { CryptoCipher } from '../common/infra/crypto.cipher';
import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { DeliveryModule } from '../delivery/delivery.module';
import { PartnerCompanyExternModule } from '../partner_company_extern/partner.company.extern.module';
import { SsgInsertStateModule } from '../delivery/ssg.insert.state.module';
import { DeliveryCutoverModule } from '../delivery/delivery.cutover.module';
import { DeliveryWorkflowEntity } from '../entity/delivery.workflow.entity';
import { MessageAttemptEntity } from '../entity/message.attempt.entity';
import { PinIssueCommandEntity } from '../entity/pin.issue.command.entity';
import { DeliveryFailureSotReader } from './application/delivery.failure.sot.reader';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      PartnerCompanyExternHistoryEntity,
      OrderDeliveryEntity,
      DeliveryWorkflowEntity,
      MessageAttemptEntity,
      PinIssueCommandEntity,
    ]),
    forwardRef(() => DeliveryModule),
    PartnerCompanyExternModule,
    SsgInsertStateModule,
    DeliveryCutoverModule,
  ],
  controllers: [PartnerCompanyExternHistoryController],
  providers: [PartnerCompanyExternHistoryService, DeliveryFailureSotReader, CryptoCipher],
  exports: [PartnerCompanyExternHistoryService],
})
export class PartnerCompanyExternHistoryModule {}
