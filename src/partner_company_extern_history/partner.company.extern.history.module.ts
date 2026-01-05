import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PartnerCompanyExternHistoryEntity } from '../entity/partner.company.extern.history.entity';
import { PartnerCompanyExternHistoryService } from './application/partner.company.extern.history.service';
import { PartnerCompanyExternHistoryController } from './api/partner.company.extern.history.controller';
import { AuthModule } from '../auth/auth.module';
import { CryptoCipher } from '../common/infra/crypto.cipher';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([PartnerCompanyExternHistoryEntity])],
  controllers: [PartnerCompanyExternHistoryController],
  providers: [PartnerCompanyExternHistoryService, CryptoCipher],
  exports: [PartnerCompanyExternHistoryService],
})
export class PartnerCompanyExternHistoryModule {}