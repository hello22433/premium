import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { AuthService } from '../../auth/application/auth.service';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { retryOnLockConflict } from '../domain/lock.retry';
import {
  PartnerSettleAdjustmentProposalService,
  AdjustmentActor,
} from '../application/partner.settle.adjustment.proposal.service';
import {
  AdjustmentProposalQueryDto,
  AdjustmentProposalCreateDto,
  AdjustmentProposalApproveDto,
  AdjustmentProposalRejectDto,
} from './dto/adjustment.proposal.dto';

/**
 * 정산 차액 제안(adjustment proposal) 조회·생성·승인·반려 (PR3C §7).
 *
 * 권한: `SETTLE_PARTNER_CONFIRM`. 기안자·결정자 분리는 서비스·DB CHECK 가 강제한다.
 * 취소/수정 endpoint 없음 (정본 §9).
 */
@Controller('')
@ApiTags('settle')
@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
export class AdjustmentProposalController {
  constructor(
    private readonly proposalService: PartnerSettleAdjustmentProposalService,
    private readonly authService: AuthService,
  ) {}

  @ApiOperation({ summary: '차액 제안 목록 (cursor pagination)' })
  @Get('settle/adjustment/proposals')
  async findProposals(@User() user: ILoginUserInfo, @Query() query: AdjustmentProposalQueryDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    return this.proposalService.findProposals(query);
  }

  @ApiOperation({ summary: '수동 차액 제안 생성' })
  @Post('settle/adjustment/proposals')
  async create(@User() user: ILoginUserInfo, @Body() body: AdjustmentProposalCreateDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    const actor: AdjustmentActor = { id: user.id, email: user.email };
    return retryOnLockConflict(() => this.proposalService.createManual(body, actor));
  }

  @ApiOperation({ summary: '차액 제안 승인 (단건 또는 그룹 자동 판정)' })
  @Post('settle/adjustment/proposals/:id/approve')
  async approve(
    @User() user: ILoginUserInfo,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: AdjustmentProposalApproveDto,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    const actor: AdjustmentActor = { id: user.id, email: user.email };
    return retryOnLockConflict(() => this.proposalService.approve(id, body, actor));
  }

  @ApiOperation({ summary: '차액 제안 반려 (단건 또는 그룹 자동 판정)' })
  @Post('settle/adjustment/proposals/:id/reject')
  async reject(
    @User() user: ILoginUserInfo,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: AdjustmentProposalRejectDto,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    const actor: AdjustmentActor = { id: user.id, email: user.email };
    return retryOnLockConflict(() => this.proposalService.reject(id, body, actor));
  }
}
