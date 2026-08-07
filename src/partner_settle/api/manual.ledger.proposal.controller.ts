import { Body, Controller, NotFoundException, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { User } from '../../auth/api/user.decorator';
import { AuthService } from '../../auth/application/auth.service';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { PartnerSettleFeatureFlag } from '../application/partner.settle.feature.flag';
import { PartnerProviderManualLedgerService } from '../application/partner.provider.manual.ledger.service';
import {
  ManualLedgerProposalApproveReqDto,
  ManualLedgerProposalProposeReqDto,
  ManualLedgerProposalRejectReqDto,
} from './dto/manual.ledger.proposal.dto';

@Controller('settle/provider-events/manual-ledger-proposals')
@ApiTags('settle-manual-ledger-proposal')
@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
export class ManualLedgerProposalController {
  constructor(
    private readonly service: PartnerProviderManualLedgerService,
    private readonly authService: AuthService,
    private readonly featureFlag: PartnerSettleFeatureFlag,
  ) {}
  @Post('propose')
  @ApiOperation({ summary: 'orphan 수동 원장화/폐기 제안' })
  @ApiOkResponse()
  async propose(@User() user: ILoginUserInfo, @Body() body: ManualLedgerProposalProposeReqDto) {
    await this.authorize(user);
    return this.service.propose(body, user.id);
  }
  @Post(':proposalId/approve')
  @ApiOperation({ summary: 'orphan 수동 원장 제안 승인' })
  @ApiOkResponse()
  async approve(
    @User() user: ILoginUserInfo,
    @Param('proposalId', ParseIntPipe) proposalId: number,
    @Body() body: ManualLedgerProposalApproveReqDto,
  ) {
    await this.authorize(user);
    return this.service.approve(proposalId, user.id, body.decisionReason);
  }
  @Post(':proposalId/reject')
  @ApiOperation({ summary: 'orphan 수동 원장 제안 반려' })
  @ApiOkResponse()
  async reject(
    @User() user: ILoginUserInfo,
    @Param('proposalId', ParseIntPipe) proposalId: number,
    @Body() body: ManualLedgerProposalRejectReqDto,
  ) {
    await this.authorize(user);
    return this.service.reject(proposalId, user.id, body.reason);
  }
  private async authorize(user: ILoginUserInfo) {
    if (!this.featureFlag.isReviewResolutionEnabled)
      throw new NotFoundException('정산 검토 해소 API 가 아직 활성화되지 않았습니다.');
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
  }
}
