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
}
