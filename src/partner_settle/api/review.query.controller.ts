import { Controller, Get, NotFoundException, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { User } from '../../auth/api/user.decorator';
import { AuthService } from '../../auth/application/auth.service';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { PartnerSettleFeatureFlag } from '../application/partner.settle.feature.flag';
import { PartnerSettleReviewQueryService } from '../application/partner.settle.review.query.service';
import { ManualLedgerProposalQueryDto, NeedsReviewQueryDto, OrphanInboxQueryDto } from './dto/review.query.dto';

@Controller('settle')
@ApiTags('settle-review-query')
@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
export class ReviewQueryController {
  constructor(
    private readonly reviewQueryService: PartnerSettleReviewQueryService,
    private readonly authService: AuthService,
    private readonly featureFlag: PartnerSettleFeatureFlag,
  ) {}

  @Get('ledger/needs-review')
  @ApiOperation({ summary: '원장·전이 관측·orphan 통합 검토 목록' })
  @ApiOkResponse({ description: 'createdAt, source, id cursor 순서의 검토 목록' })
  async needsReview(@User() user: ILoginUserInfo, @Query() query: NeedsReviewQueryDto) {
    await this.authorize(user);
    return this.reviewQueryService.findNeedsReview(query);
  }

  @Get('provider-events/manual-ledger-proposals')
  @ApiOperation({ summary: 'orphan 수동 원장 제안 목록' })
  @ApiOkResponse({ description: 'inbox 상태와 승인 결과 원장 ID를 포함한 제안 목록' })
  async manualLedgerProposals(@User() user: ILoginUserInfo, @Query() query: ManualLedgerProposalQueryDto) {
    await this.authorize(user);
    return this.reviewQueryService.findManualLedgerProposals(query);
  }

  @Get('provider-events/orphan-inbox')
  @ApiOperation({ summary: '미원장 orphan inbox 목록' })
  @ApiOkResponse({ description: 'REJECTED 이력과 무관하게 ORPHAN_PENDING row를 반환' })
  async orphanInbox(@User() user: ILoginUserInfo, @Query() query: OrphanInboxQueryDto) {
    await this.authorize(user);
    return this.reviewQueryService.findOrphanInbox(query);
  }

  private async authorize(user: ILoginUserInfo): Promise<void> {
    if (!this.featureFlag.isReviewResolutionEnabled) {
      throw new NotFoundException('정산 검토 조회 API 가 아직 활성화되지 않았습니다.');
    }
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
  }
}
