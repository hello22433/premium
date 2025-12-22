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

  // 30분 마다 실행 - 쿠폰 상태 조회
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

  // 매일 03:01에 실행 - 갤럭시아 일대사 (전날 사용 내역 조회)
  @Cron('0 1 3 * * *')
  async checkGalaxiaDaily() {
    try {
      this.logger.log('Start checkGalaxiaDaily');
      await this.partnerCompanyExternBatchService.checkGalaxiaDaily();
      this.logger.log('Complete checkGalaxiaDaily');
    } catch (e) {
      this.logger.error(e);
    }
  }
}
