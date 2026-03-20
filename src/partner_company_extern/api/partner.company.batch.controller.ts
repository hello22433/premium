import { Controller, Logger, Post, Query, UseGuards } from '@nestjs/common';
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
}
