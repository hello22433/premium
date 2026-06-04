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

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([PartnerCompanyExternHistoryEntity, OrderDeliveryEntity]),
    forwardRef(() => DeliveryModule),
    PartnerCompanyExternModule,
    SsgInsertStateModule,
  ],
  controllers: [PartnerCompanyExternHistoryController],
  providers: [PartnerCompanyExternHistoryService, CryptoCipher],
  exports: [PartnerCompanyExternHistoryService],
})
export class PartnerCompanyExternHistoryModule {}