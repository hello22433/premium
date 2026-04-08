import { Controller, Get, Logger, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { AuthUserSuperAdminGuard } from '../../auth/api/auth.user.super-admin.guard';
import { PartnerCompanyExternBatchService } from '../application/partner.company.extern.batch.service';

@Controller('')
@ApiTags('batch')
@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard, AuthUserSuperAdminGuard)
export class PartnerCompanyBatchController {
  private logger = new Logger('PARTNER_COMPANY_BATCH');

  constructor(private partnerCompanyExternBatchService: PartnerCompanyExternBatchService) {}

  @ApiOperation({ summary: '[임시] 갤럭시아 일대사 수동 실행' })
  @Post('batch/galaxia-daily')
  async triggerGalaxiaDaily(@Query('targetDay') targetDay?: string) {
    this.logger.log(`[수동실행] checkGalaxiaDaily 시작 - targetDay: ${targetDay ?? '어제'}`);
    await this.partnerCompanyExternBatchService.checkGalaxiaDaily(targetDay);
    this.logger.log('[수동실행] checkGalaxiaDaily 완료');
    return { message: 'checkGalaxiaDaily 실행 완료' };
  }

  @ApiOperation({ summary: '[임시] 갤럭시아 일대사 기간 일괄 실행 (startDay~endDay)' })
  @Post('batch/galaxia-daily-range')
  async triggerGalaxiaDailyRange(
    @Query('startDay') startDay: string,
    @Query('endDay') endDay: string,
  ) {
    if (!startDay || !endDay || startDay.length !== 8 || endDay.length !== 8) {
      return { message: 'startDay, endDay를 YYYYMMDD 형식으로 입력해주세요.' };
    }
    if (startDay > endDay) {
      return { message: 'startDay가 endDay보다 클 수 없습니다.' };
    }

    this.logger.log(`[수동실행] checkGalaxiaDaily 기간 실행: ${startDay} ~ ${endDay}`);

    const results: Array<{ day: string; status: string }> = [];
    let current = startDay;

    while (current <= endDay) {
      try {
        await this.partnerCompanyExternBatchService.checkGalaxiaDaily(current);
        results.push({ day: current, status: 'OK' });
      } catch (e) {
        this.logger.error(`[수동실행] checkGalaxiaDaily 실패: ${current}`, e);
        results.push({ day: current, status: 'FAIL' });
      }

      // 다음 날짜로 이동
      const year = parseInt(current.substring(0, 4));
      const month = parseInt(current.substring(4, 6)) - 1;
      const day = parseInt(current.substring(6, 8));
      const nextDate = new Date(year, month, day + 1);
      current = nextDate.getFullYear().toString() +
        (nextDate.getMonth() + 1).toString().padStart(2, '0') +
        nextDate.getDate().toString().padStart(2, '0');
    }

    this.logger.log(`[수동실행] checkGalaxiaDaily 기간 실행 완료: ${results.length}일 처리`);
    return { message: `${results.length}일 처리 완료`, results };
  }

  @ApiOperation({ summary: '갤럭시아 백화점(dept) 사용내역 배치 수동 실행' })
  @Post('batch/galaxia-dept-usage')
  async triggerGalaxiaDeptUsage() {
    this.logger.log('[수동실행] checkGalaxiaDeptUsage 시작');
    await this.partnerCompanyExternBatchService.checkGalaxiaDeptUsage();
    this.logger.log('[수동실행] checkGalaxiaDeptUsage 완료');
    return { message: 'checkGalaxiaDeptUsage 실행 완료' };
  }

  @ApiOperation({ summary: '[임시] 컬쳐랜드 일대사 수동 실행 (60일 상품 만료 처리 포함)' })
  @Post('batch/cultureland-daily')
  async triggerCulturelandDaily(@Query('useDate') useDate?: string) {
    this.logger.log(`[수동실행] checkCulturelandDaily 시작 - useDate: ${useDate ?? '어제'}`);
    await this.partnerCompanyExternBatchService.checkCulturelandDaily(useDate);
    this.logger.log('[수동실행] checkCulturelandDaily 완료');
    return { message: 'checkCulturelandDaily 실행 완료' };
  }

  @ApiOperation({ summary: '[임시] 외부사 사용내역 체크 배치 수동 실행 (check)' })
  @Post('batch/extern-check')
  async triggerExternCheck() {
    this.logger.log('[수동실행] check 시작');
    const stats = await this.partnerCompanyExternBatchService.check();
    this.logger.log('[수동실행] check 완료');
    return { message: 'check 실행 완료', stats };
  }

  @ApiOperation({ summary: '[임시] 특정 orderId 발송건 전체 상태조회 (일회성)' })
  @Post('batch/extern-check-by-order')
  async triggerExternCheckByOrder(@Query('orderId') orderId: string) {
    const orderIdNum = Number(orderId);
    if (!orderId || !Number.isInteger(orderIdNum) || orderIdNum <= 0) {
      return { message: 'orderId를 양의 정수로 입력해주세요.' };
    }
    this.logger.log(`[수동실행] checkByOrderId 시작 - orderId=${orderIdNum}`);
    const stats = await this.partnerCompanyExternBatchService.checkByOrderId(orderIdNum);
    this.logger.log(`[수동실행] checkByOrderId 완료 - orderId=${orderIdNum}`);
    return { message: 'checkByOrderId 실행 완료', stats };
  }

  @ApiOperation({ summary: '갤럭시아 바코드 로그 백필 (일대사 누락분)' })
  @Get('batch/galaxia-backfill')
  async triggerGalaxiaBackfill() {
    this.logger.log('[수동실행] backfillMissingGalaxiaLogs 시작');
    const result = await this.partnerCompanyExternBatchService.backfillMissingGalaxiaLogs();
    this.logger.log('[수동실행] backfillMissingGalaxiaLogs 완료');
    return { message: '백필 실행 완료', ...result };
  }
}
