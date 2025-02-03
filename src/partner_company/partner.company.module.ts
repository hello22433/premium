import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PartnerCompanyEntity } from '../entity/partner.company.entity';
import { PartnerCompanyController } from './api/partner.company.controller';
import { PartnerCompanyService } from './application/partner.company.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([PartnerCompanyEntity])],
  controllers: [PartnerCompanyController],
  providers: [PartnerCompanyService],
})
export class PartnerCompanyModule {}
