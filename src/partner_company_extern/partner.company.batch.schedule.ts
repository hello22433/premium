import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PartnerCompanyExternBatchService } from './application/partner.company.extern.batch.service';
import { Cron } from '@nestjs/schedule';

@Injectable()
export class PartnerCompanyBatchSchedule implements OnApplicationBootstrap {
  private logger = new Logger('PARTNER_COMPANY_BATCH');

  constructor(private partnerCompanyExternBatchService: PartnerCompanyExternBatchService) {}

  async onApplicationBootstrap() {
    // TEST: 갤럭시아 일대사 과거 데이터 수집 (테스트 후 삭제)
    const days = ['20260201', '20260202', '20260203', '20260204', '20260205', '20260206', '20260207', '20260208', '20260209'];
    for (const day of days) {
      try {
        this.logger.log(`[TEST] checkGalaxiaDaily 시작 - targetDay: ${day}`);
        await this.partnerCompanyExternBatchService.checkGalaxiaDaily(day);
        this.logger.log(`[TEST] checkGalaxiaDaily 완료 - targetDay: ${day}`);
      } catch (e) {
        this.logger.error(`[TEST] checkGalaxiaDaily 실패 - targetDay: ${day}`);
        this.logger.error(e);
      }
    }
    this.logger.log('[TEST] 전체 과거 데이터 수집 완료');
  }

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
}
