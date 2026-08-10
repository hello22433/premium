import { Body, Controller, NotFoundException, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { User } from '../../auth/api/user.decorator';
import { AuthService } from '../../auth/application/auth.service';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { PartnerSettleFeatureFlag } from '../application/partner.settle.feature.flag';
import { PartnerSettleTransitionResolutionService } from '../application/partner.settle.transition.resolution.service';
import {
  TransitionResolutionApproveReqDto,
  TransitionResolutionProposeReqDto,
  TransitionResolutionRejectReqDto,
} from './dto/transition.resolution.dto';

@Controller('settle/ledger/transitions')
@ApiTags('settle-transition-resolution')
@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
export class TransitionResolutionController {
  constructor(
    private readonly service: PartnerSettleTransitionResolutionService,
    private readonly authService: AuthService,
    private readonly featureFlag: PartnerSettleFeatureFlag,
  ) {}

  @Post(':observationId/propose')
  @ApiOperation({ summary: '미복원 전이 해소 제안' })
  @ApiOkResponse()
  async propose(
    @User() user: ILoginUserInfo,
    @Param('observationId', ParseIntPipe) observationId: number,
    @Body() body: TransitionResolutionProposeReqDto,
  ) {
    this.assertEnabled();
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    return this.service.propose(observationId, body, user.id);
  }

  @Post(':proposalId/approve')
  async approve(
    @User() user: ILoginUserInfo,
    @Param('proposalId', ParseIntPipe) proposalId: number,
    @Body() body: TransitionResolutionApproveReqDto,
  ) {
    this.assertEnabled();
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    return this.service.approve(proposalId, user.id, body.decisionReason);
  }

  @Post(':proposalId/reject')
  async reject(
    @User() user: ILoginUserInfo,
    @Param('proposalId', ParseIntPipe) proposalId: number,
    @Body() body: TransitionResolutionRejectReqDto,
  ) {
    this.assertEnabled();
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    return this.service.reject(proposalId, user.id, body.reason);
  }

  private assertEnabled(): void {
    if (!this.featureFlag.isReviewResolutionEnabled)
      throw new NotFoundException('정산 전이 해소 API 가 아직 활성화되지 않았습니다.');
  }
}
