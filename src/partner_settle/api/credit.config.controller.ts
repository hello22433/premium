import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { AuthService } from '../../auth/application/auth.service';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { PartnerCreditConfigService } from '../application/partner.credit.config.service';
import { CreditFeatureFlag } from '../application/credit.feature.flag';
import { assertCreditApiEnabled } from './credit.feature.guard';
import {
  CreditConfigPutReqDto,
  CreditConfigPutResultDto,
  CreditConfigViewDto,
} from './dto/credit.config.dto';

@Controller('')
@ApiTags('settle-credit')
@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
export class CreditConfigController {
  constructor(
    private readonly configService: PartnerCreditConfigService,
    private readonly authService: AuthService,
    private readonly featureFlag: CreditFeatureFlag,
  ) {}

  @ApiOperation({ summary: '여신관리 > 협력사 여신 설정(월한도 파라미터) 조회' })
  @ApiOkResponse({ type: [CreditConfigViewDto] })
  @Get('settle/credit/config/:partnerCompanyId')
  async getConfig(
    @User() user: ILoginUserInfo,
    @Param('partnerCompanyId', ParseIntPipe) partnerCompanyId: number,
  ): Promise<CreditConfigViewDto[]> {
    assertCreditApiEnabled(this.featureFlag);
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_CREDIT);
    return this.configService.getConfig(partnerCompanyId);
  }

  @ApiOperation({
    summary: '여신관리 > 협력사 여신 설정 갱신 (all-or-nothing 배치 · optimistic lock)',
  })
  @ApiOkResponse({ type: [CreditConfigPutResultDto] })
  @Put('settle/credit/config/:partnerCompanyId')
  async putConfig(
    @User() user: ILoginUserInfo,
    @Param('partnerCompanyId', ParseIntPipe) partnerCompanyId: number,
    @Body() body: CreditConfigPutReqDto,
  ): Promise<CreditConfigPutResultDto[]> {
    assertCreditApiEnabled(this.featureFlag);
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_CREDIT);
    return this.configService.putConfig(partnerCompanyId, body.items, user.id);
  }
}
