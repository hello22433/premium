import { Module } from '@nestjs/common';
import { GalaxiaHttp } from './infra/galaxia.http';
import { GiftielHttp } from './infra/giftiel.http';
import { GsmbizHttp } from './infra/gsmbiz.http';
import { GiftishowHttp } from './infra/giftishow.http';
import { CultureSocket } from './infra/culture.socket';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { PartnerCompanyExternService } from './application/partner.company.extern.service';
import { CryptoCipher } from '../common/infra/crypto.cipher';
import { PartnerCompanyExternHistoryEntity } from '../entity/partner.company.extern.history.entity';
import { SsgIssue } from './infra/ssg.issue';

@Module({
  imports: [HttpModule, TypeOrmModule.forFeature([OrderDeliveryEntity, PartnerCompanyExternHistoryEntity])],
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
    PartnerCompanyExternService,
    CryptoCipher,
  ],
  exports: [PartnerCompanyExternService],
})
export class PartnerCompanyExternModule {}
