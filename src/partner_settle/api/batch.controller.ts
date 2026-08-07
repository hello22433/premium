import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { AuthService } from '../../auth/application/auth.service';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { PartnerSettleBatchService } from '../application/partner.settle.batch.service';
import { PartnerSettleFeatureFlag } from '../application/partner.settle.feature.flag';
import { PartnerSettlePaymentService } from '../application/partner.settle.payment.service';
import {
  BatchQueryDto,
  BatchSummaryResDto,
  ConfirmReqDto,
  ConfirmResDto,
  HoldReleaseReqDto,
  PaidReqDto,
  UnconfirmReqDto,
  UnconfirmResDto,
} from './dto/batch.dto';

@Controller('')
@ApiTags('settle/partner-company')
@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
export class BatchController {
  constructor(
    private readonly batchService: PartnerSettleBatchService,
    private readonly paymentService: PartnerSettlePaymentService,
    private readonly authService: AuthService,
    private readonly featureFlag: PartnerSettleFeatureFlag,
  ) {}

  @ApiOperation({ summary: '정산확정 (confirm sweep)' })
  @ApiOkResponse({ type: ConfirmResDto })
  @Post('settle/partner-company/batches/confirm')
  async confirm(@User() user: ILoginUserInfo, @Body() body: ConfirmReqDto): Promise<ConfirmResDto> {
    this.assertConfirmEnabled();
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    return this.batchService.confirm(body, user.id);
  }

  @ApiOperation({ summary: '확정 해제 (건별/배치)' })
  @ApiOkResponse({ type: UnconfirmResDto })
  @Put('settle/partner-company/batches/:id/unconfirm')
  async unconfirm(
    @User() user: ILoginUserInfo,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UnconfirmReqDto,
  ): Promise<UnconfirmResDto> {
    this.assertConfirmEnabled();
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    return this.batchService.unconfirm(id, body, user.id);
  }

  @ApiOperation({ summary: '배치 목록 조회' })
  @ApiOkResponse({ type: [BatchSummaryResDto] })
  @Get('settle/partner-company/batches')
  async findBatches(@User() user: ILoginUserInfo, @Query() query: BatchQueryDto): Promise<BatchSummaryResDto[]> {
    this.assertConfirmEnabled();
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    return this.batchService.findBatches(query);
  }

  @ApiOperation({ summary: '배치 상세 조회' })
  @Get('settle/partner-company/batches/:id')
  async findBatch(@User() user: ILoginUserInfo, @Param('id', ParseIntPipe) id: number) {
    this.assertConfirmEnabled();
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    return this.batchService.findBatch(id);
  }

  @ApiOperation({ summary: 'ON_HOLD 해제' })
  @Put('settle/ledger/:id/hold-release')
  async holdRelease(
    @User() user: ILoginUserInfo,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: HoldReleaseReqDto,
  ): Promise<void> {
    this.assertConfirmEnabled();
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    return this.batchService.holdRelease(id, body.reason, user.id);
  }

  @ApiOperation({ summary: '지급 완료 처리 (일반 200 / variance 202)' })
  @Put('settle/partner-company/batches/:id/paid')
  async paid(
    @User() user: ILoginUserInfo,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: PaidReqDto,
    @Res({ passthrough: true }) res: any,
  ) {
    this.assertPaidEnabled();
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    const { statusCode, result } = await this.paymentService.paid(id, body, user.id);
    res.status(statusCode);
    return result;
  }

  @ApiOperation({ summary: '협력사 정산 경계 config 조회' })
  @Get('settle/partner-company/config')
  async getConfig(@User() user: ILoginUserInfo, @Query('partnerCompanyId', ParseIntPipe) partnerCompanyId: number) {
    this.assertConfirmEnabled();
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    return this.batchService.findConfig(partnerCompanyId);
  }

  private assertConfirmEnabled(): void {
    if (!this.featureFlag.isConfirmEnabled) {
      throw new NotFoundException('정산확정 API가 아직 활성화되지 않았습니다.');
    }
  }

  private assertPaidEnabled(): void {
    if (!this.featureFlag.isPaidEnabled) {
      throw new NotFoundException('지급 API가 아직 활성화되지 않았습니다.');
    }
  }
}
