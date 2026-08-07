import { Controller, Get, Inject, Logger, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { IGiftiShow } from '../interface/giftishow';

@Controller('partner-company-extern')
@ApiTags('partner-company-extern')
@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard, AuthUserSuperAndOperationAdminGuard)
export class GiftishowBalanceController {
  private logger = new Logger('GIFTI_SHOW_BALANCE');

  constructor(
    @Inject('IGiftiShow')
    private giftiShow: IGiftiShow,
  ) {}

  @ApiOperation({
    summary: '기프티쇼 발송한도(기업고객 포인트 잔액) 조회',
    description:
      '기프티쇼 0305 API 를 호출해 한도금액(loanLimit)/사용가능금액(usePosblAmt)을 조회한다. 읽기 전용, DB 변경 없음.',
  })
  @Get('giftishow/balance')
  async getGiftishowBalance() {
    this.logger.log('[조회] 기프티쇼 발송한도 조회 시작');
    const result = await this.giftiShow.getCompanyBalance();
    this.logger.log(`[조회] 기프티쇼 발송한도 조회 완료 - resCode=${result.resCode}`);

    return {
      resCode: result.resCode,
      resMsg: result.resMsg,
      loanLimit: result.pointCompanyBalance ? Number(result.pointCompanyBalance.loanLimit) : null,
      usePosblAmt: result.pointCompanyBalance ? Number(result.pointCompanyBalance.usePosblAmt) : null,
    };
  }
}
