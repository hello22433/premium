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

    // TODO: 1월 데이터 백필 완료 후 삭제
    for (let day = 1; day <= 31; day++) {
      const targetDay = `202601${String(day).padStart(2, '0')}`;
      try {
        this.logger.log(`[백필] checkGalaxiaDaily 시작 - targetDay: ${targetDay}`);
        await this.partnerCompanyExternBatchService.checkGalaxiaDaily(targetDay);
        this.logger.log(`[백필] checkGalaxiaDaily 완료 - targetDay: ${targetDay}`);
      } catch (e) {
        this.logger.error(`[백필] checkGalaxiaDaily 실패 - targetDay: ${targetDay}`);
        this.logger.error(e);
      }
    }
    this.logger.log('[백필] 1월 데이터 백필 완료');
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
