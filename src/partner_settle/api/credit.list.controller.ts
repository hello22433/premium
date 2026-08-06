import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { AuthService } from '../../auth/application/auth.service';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { PartnerCreditListService } from '../application/partner.credit.list.service';
import { CreditFeatureFlag } from '../application/credit.feature.flag';
import { assertCreditApiEnabled } from './credit.feature.guard';
import { CreditListResDto } from './dto/credit.list.dto';

@Controller('')
@ApiTags('settle-credit')
@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
export class CreditListController {
  constructor(
    private readonly listService: PartnerCreditListService,
    private readonly authService: AuthService,
    private readonly featureFlag: CreditFeatureFlag,
  ) {}

  @ApiOperation({
    summary: '여신관리 > 협력사 여신 표 조회 (현재 스냅샷 · 미정산·전월·발송가능잔액·지급조정)',
  })
  @ApiOkResponse({ type: CreditListResDto })
  @Get('settle/credit/list')
  async getList(@User() user: ILoginUserInfo): Promise<CreditListResDto> {
    assertCreditApiEnabled(this.featureFlag);
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_CREDIT);
    return this.listService.getList();
  }
}
