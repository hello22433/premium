import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { AuthService } from '../../auth/application/auth.service';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import {
  PartnerSettlePaymentVarianceService,
  VarianceActor,
} from '../application/partner.settle.payment.variance.service';
import { VarianceDecisionReqDto, VarianceQueryDto } from './dto/payment.variance.dto';

/**
 * 지급 차이(PAYMENT_VARIANCE) 조회·승인·반려 (정본 §9 · PR3A).
 *
 * 권한은 지급과 같은 `SETTLE_PARTNER_CONFIRM` 이다. **기안자와 결정자 분리는 권한이 아니라
 * 서비스·DB CHECK 가 강제한다**(같은 권한을 가진 다른 사람이 결정해야 한다).
 *
 * proposal 취소 endpoint 는 없다(정본 §13) — 잘못 기안했으면 반려로 종결하고 재기안한다.
 */
@Controller('')
@ApiTags('settle/partner-company')
@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
export class PaymentVarianceController {
  constructor(
    private readonly varianceService: PartnerSettlePaymentVarianceService,
    private readonly authService: AuthService,
  ) {}

  @ApiOperation({ summary: '지급 차이 proposal 목록' })
  @Get('settle/partner-company/payment-variance-proposals')
  async findProposals(@User() user: ILoginUserInfo, @Query() query: VarianceQueryDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    return this.varianceService.findProposals(query);
  }

  @ApiOperation({ summary: '지급 차이 proposal 상세' })
  @Get('settle/partner-company/payment-variance-proposals/:id')
  async findProposal(@User() user: ILoginUserInfo, @Param('id', ParseIntPipe) id: number) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    return this.varianceService.findProposal(id);
  }

  @ApiOperation({ summary: '지급 차이 승인 (ADJUSTMENT 원장 1건 생성 + batch PAID)' })
  @Post('settle/partner-company/payment-variance-proposals/:id/approve')
  async approve(
    @User() user: ILoginUserInfo,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: VarianceDecisionReqDto,
    @Req() req: Request,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    return this.varianceService.approve(id, body, this.toActor(user, req));
  }

  @ApiOperation({ summary: '지급 차이 반려 (batch 는 CONFIRMED_UNPAID 유지)' })
  @Post('settle/partner-company/payment-variance-proposals/:id/reject')
  async reject(
    @User() user: ILoginUserInfo,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: VarianceDecisionReqDto,
    @Req() req: Request,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    return this.varianceService.reject(id, body, this.toActor(user, req));
  }

  private toActor(user: ILoginUserInfo, req: Request): VarianceActor {
    return {
      id: user.id,
      email: user.email,
      ipAddress: req.ip || req.headers['x-forwarded-for']?.toString() || '',
    };
  }
}
