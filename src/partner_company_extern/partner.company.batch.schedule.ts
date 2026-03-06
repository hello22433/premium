import { Injectable, Logger } from '@nestjs/common';
import { PartnerCompanyExternBatchService } from './application/partner.company.extern.batch.service';
import { Cron } from '@nestjs/schedule';

@Injectable()
export class PartnerCompanyBatchSchedule {
  private logger = new Logger('PARTNER_COMPANY_BATCH');

  constructor(private partnerCompanyExternBatchService: PartnerCompanyExternBatchService) {}

  // 매일 02:15 실행 - 쿠폰 상태 조회 (레거시 방식: 하루 1회)
  @Cron('0 15 2 * * *')
  async check() {
    try {
      this.logger.log('Start check');
      await this.partnerCompanyExternBatchService.check();
      this.logger.log('Complete check');
    } catch (e) {
      this.logger.error(e);
    }
  }

  // 매일 03:15에 실행 - 갤럭시아 일대사 (전날 사용 내역 조회)
  @Cron('0 15 3 * * *')
  async checkGalaxiaDaily() {
    try {
      this.logger.log('Start checkGalaxiaDaily');
      await this.partnerCompanyExternBatchService.checkGalaxiaDaily();
      this.logger.log('Complete checkGalaxiaDaily');
    } catch (e) {
      this.logger.error(e);
    }
  }

  // 매일 07:15에 실행 - 컬쳐랜드 일대사 (60일 상품 전용, 전날 사용 내역 조회)
  // 컬쳐랜드 점검시간 06:01~06:59 이후
  @Cron('0 15 7 * * *')
  async checkCulturelandDaily() {
    try {
      this.logger.log('Start checkCulturelandDaily');
      await this.partnerCompanyExternBatchService.checkCulturelandDaily();
      this.logger.log('Complete checkCulturelandDaily');
    } catch (e) {
      this.logger.error(e);
    }
  }


  // 매일 23:42에 실행 - 갤럭시아 백화점(dept) 상품 사용내역 조회
  // 일대사로 누락되는 네이버페이 등 사용내역을 개별 check API로 감지
  @Cron('0 42 23 * * *')
  async checkGalaxiaDeptUsage() {
    try {
      this.logger.log('Start checkGalaxiaDeptUsage');
      await this.partnerCompanyExternBatchService.checkGalaxiaDeptUsage();
      this.logger.log('Complete checkGalaxiaDeptUsage');
    } catch (e) {
      this.logger.error(e);
    }
  }
}
