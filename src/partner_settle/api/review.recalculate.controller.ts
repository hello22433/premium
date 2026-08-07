import { Body, Controller, NotFoundException, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { User } from '../../auth/api/user.decorator';
import { AuthService } from '../../auth/application/auth.service';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { PartnerSettleFeatureFlag } from '../application/partner.settle.feature.flag';
import { PartnerSettleReviewRecalculateService } from '../application/partner.settle.review.recalculate.service';
import { ReviewRecalculateReqDto } from './dto/review.recalculate.dto';

@Controller('settle/ledger/needs-review')
@ApiTags('settle-review-recalculate')
@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
export class ReviewRecalculateController {
  constructor(
    private readonly recalculateService: PartnerSettleReviewRecalculateService,
    private readonly authService: AuthService,
    private readonly featureFlag: PartnerSettleFeatureFlag,
  ) {}

  @Post('recalculate')
  @ApiOperation({ summary: 'deterministic NEEDS_REVIEW 원장 재계산' })
  @ApiOkResponse({ description: '재계산 성공 및 실패 원장 목록' })
  async recalculate(@User() user: ILoginUserInfo, @Body() body: ReviewRecalculateReqDto) {
    this.assertEnabled();
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    const target =
      body.ledgerIds !== undefined
        ? { ledgerIds: body.ledgerIds }
        : body.subItemKey === undefined
          ? { partnerCompanyId: body.partnerCompanyId! }
          : { partnerCompanyId: body.partnerCompanyId!, subItemKey: body.subItemKey };
    return this.recalculateService.recalculate(target, user.id);
  }

  private assertEnabled(): void {
    if (!this.featureFlag.isReviewResolutionEnabled) {
      throw new NotFoundException('정산 검토 재계산 API 가 아직 활성화되지 않았습니다.');
    }
  }
}
