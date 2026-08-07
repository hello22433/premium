import { Body, Controller, NotFoundException, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { User } from '../../auth/api/user.decorator';
import { AuthService } from '../../auth/application/auth.service';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { PartnerSettleFeatureFlag } from '../application/partner.settle.feature.flag';
import { PartnerSettleReviewResolutionService } from '../application/partner.settle.review.resolution.service';
import {
  ReviewResolutionApproveReqDto,
  ReviewResolutionProposeReqDto,
  ReviewResolutionRejectReqDto,
} from './dto/review.resolution.dto';

@Controller('settle/ledger/needs-review/resolve')
@ApiTags('settle-review-resolution')
@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
export class ReviewResolutionController {
  constructor(
    private readonly resolutionService: PartnerSettleReviewResolutionService,
    private readonly authService: AuthService,
    private readonly featureFlag: PartnerSettleFeatureFlag,
  ) {}

  @ApiOperation({ summary: 'NEEDS_REVIEW 원장 해소 제안' })
  @ApiOkResponse({ description: '검토 제안 결과' })
  @Post('propose')
  async propose(@User() user: ILoginUserInfo, @Body() body: ReviewResolutionProposeReqDto) {
    this.assertEnabled();
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    return this.resolutionService.propose(body, user.id);
  }

  @ApiOperation({ summary: 'NEEDS_REVIEW 원장 해소 제안 승인' })
  @ApiOkResponse({ description: '검토 제안 승인 결과' })
  @Post(':proposalId/approve')
  async approve(
    @User() user: ILoginUserInfo,
    @Param('proposalId', ParseIntPipe) proposalId: number,
    @Body() body: ReviewResolutionApproveReqDto,
  ) {
    this.assertEnabled();
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    return this.resolutionService.approve(proposalId, user.id, body.decisionReason);
  }

  @ApiOperation({ summary: 'NEEDS_REVIEW 원장 해소 제안 반려' })
  @ApiOkResponse({ description: '검토 제안 반려 결과' })
  @Post(':proposalId/reject')
  async reject(
    @User() user: ILoginUserInfo,
    @Param('proposalId', ParseIntPipe) proposalId: number,
    @Body() body: ReviewResolutionRejectReqDto,
  ) {
    this.assertEnabled();
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    return this.resolutionService.reject(proposalId, user.id, body.reason);
  }

  private assertEnabled(): void {
    if (!this.featureFlag.isReviewResolutionEnabled) {
      throw new NotFoundException('정산 검토 해소 API 가 아직 활성화되지 않았습니다.');
    }
  }
}
