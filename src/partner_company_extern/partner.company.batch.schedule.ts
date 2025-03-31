import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PartnerCompanyExternBatchService } from './application/partner.company.extern.batch.service';
import { Cron } from '@nestjs/schedule';

@Injectable()
export class PartnerCompanyBatchSchedule implements OnApplicationBootstrap {
  constructor(private partnerCompanyExternBatchService: PartnerCompanyExternBatchService) {}

  onApplicationBootstrap() {
    // TEST;
    // this.check();
  }

  private logger = new Logger('PARTNER_COMPANY_BATCH');

  // 30분 마다 실행
  @Cron('0 */30 * * * *')
  async check() {
    try {
      await this.partnerCompanyExternBatchService.check();
      this.logger.log('Complete check');
      return;
    } catch (e) {
      this.logger.error(e);
    }
  }
}
