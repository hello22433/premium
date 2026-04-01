import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GalaxiaHttp } from './infra/galaxia.http';
import { GiftielHttp } from './infra/giftiel.http';
import { GsmbizHttp } from './infra/gsmbiz.http';
import { GiftishowHttp } from './infra/giftishow.http';
import { CultureSocket } from './infra/culture.socket';
import { DaouHttp } from './infra/daou.http';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { PartnerCompanyExternService } from './application/partner.company.extern.service';
import { CryptoCipher } from '../common/infra/crypto.cipher';
import { PartnerCompanyExternHistoryEntity } from '../entity/partner.company.extern.history.entity';
import { PartnerCompanyEntity } from '../entity/partner.company.entity';
import { SsgIssue } from './infra/ssg.issue';
import { PartnerCompanyExternBatchService } from './application/partner.company.extern.batch.service';
import { PartnerCompanyBatchSchedule } from './partner.company.batch.schedule';
import { PartnerCompanyBatchController } from './api/partner.company.batch.controller';
import { GalaxiaPushController } from './api/galaxia.push.controller';
import { GalaxiaIpGuard } from './api/galaxia.ip.guard';
import { GalaxiaBarcodeLogEntity } from '../entity/galaxia.barcode.log.entity';

@Module({
  imports: [
    AuthModule,
    HttpModule.register({ timeout: 30000 }),
    TypeOrmModule.forFeature([OrderDeliveryEntity, PartnerCompanyExternHistoryEntity, GalaxiaBarcodeLogEntity, PartnerCompanyEntity]),
  ],
  providers: [
    {
      provide: 'IGalaxia',
      useClass: GalaxiaHttp,
    },
    {
      provide: 'IGsmbiz',
      useClass: GsmbizHttp,
    },
    {
      provide: 'IGiftiel',
      useClass: GiftielHttp,
    },
    {
      provide: 'IGiftiShow',
      useClass: GiftishowHttp,
    },
    {
      provide: 'ICulture',
      useClass: CultureSocket,
    },
    {
      provide: 'ISsgIssue',
      useClass: SsgIssue,
    },
    {
      provide: 'IDaou',
      useClass: DaouHttp,
    },
    PartnerCompanyExternService,
    CryptoCipher,
    PartnerCompanyExternBatchService,
    PartnerCompanyBatchSchedule,
    GalaxiaIpGuard,
  ],
  controllers: [PartnerCompanyBatchController, GalaxiaPushController],
  exports: [PartnerCompanyExternService],
})
export class PartnerCompanyExternModule {}
