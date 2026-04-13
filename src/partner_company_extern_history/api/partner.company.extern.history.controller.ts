import { Controller, Get, Post, Param, Query, UseGuards, ParseIntPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { PartnerCompanyExternHistoryService } from '../application/partner.company.extern.history.service';
import {
  GetPartnerCompanyExternHistoryFilterReqDto,
  GetPartnerCompanyExternHistoryListReqDto,
} from './partner.company.extern.history.req.dto';
import {
  GetPartnerCompanyExternHistoryListResDto,
  GetPartnerCompanyTypesResDto,
  GetResendTargetIdsResDto,
  ResendResultDto,
} from './partner.company.extern.history.res.dto';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { AuthService } from '../../auth/application/auth.service';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

@Controller('')
@ApiTags('partner-company-extern-history')
@ApiBearerAuth()
@UseGuards(AuthUserSuperAndOperationAdminGuard)
export class PartnerCompanyExternHistoryController {
  constructor(
    private historyService: PartnerCompanyExternHistoryService,
    private authService: AuthService,
  ) {}

  @ApiOperation({
    summary: '발송 실패/성공 내역 목록 조회',
    description: '협력사 PIN 발급 내역을 조회합니다.',
  })
  @ApiOkResponse({
    type: GetPartnerCompanyExternHistoryListResDto,
    description: '성공적으로 조회한 경우',
  })
  @Get('/partner-company-extern-history/list')
  async getList(
    @User() user: ILoginUserInfo,
    @Query() dto: GetPartnerCompanyExternHistoryListReqDto,
  ): Promise<GetPartnerCompanyExternHistoryListResDto> {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SEND_FAIL_HISTORY);
    return this.historyService.getHistoryList(dto);
  }

  @ApiOperation({
    summary: '협력사 타입 목록 조회',
    description: '드롭다운용 협력사 타입 목록을 조회합니다.',
  })
  @ApiOkResponse({
    type: GetPartnerCompanyTypesResDto,
    description: '성공적으로 조회한 경우',
  })
  @Get('/partner-company-extern-history/types')
  async getTypes(): Promise<GetPartnerCompanyTypesResDto> {
    return this.historyService.getPartnerCompanyTypes();
  }

  @ApiOperation({
    summary: '재발송 대상 ID 목록 조회',
    description: '현재 필터 조건에 해당하는 재발송 가능한(실패 + 미재발송) orderDelivery ID 목록을 조회합니다.',
  })
  @ApiOkResponse({
    type: GetResendTargetIdsResDto,
    description: '재발송 대상 ID 목록',
  })
  @Get('/partner-company-extern-history/resend-target-ids')
  async getResendTargetIds(
    @User() user: ILoginUserInfo,
    @Query() dto: GetPartnerCompanyExternHistoryFilterReqDto,
  ): Promise<GetResendTargetIdsResDto> {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SEND_FAIL_HISTORY);
    return this.historyService.getResendTargetIds(dto);
  }

  @ApiOperation({
    summary: '발송 실패 건 재발송',
    description:
      '발송 실패한 orderDelivery를 재발송합니다. SSG의 경우 핀 미발급 건은 기존 핀을 재사용하고, 핀 발급 건은 기존 핀으로 재발송합니다.',
  })
  @ApiParam({ name: 'orderDeliveryId', description: 'orderDelivery ID', type: Number })
  @ApiOkResponse({
    type: ResendResultDto,
    description: '재발송 결과',
  })
  @Post('/partner-company-extern-history/resend/:orderDeliveryId')
  async resend(
    @User() user: ILoginUserInfo,
    @Param('orderDeliveryId', ParseIntPipe) orderDeliveryId: number,
  ): Promise<ResendResultDto> {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SEND_FAIL_HISTORY);
    return this.historyService.resendFailedDelivery(orderDeliveryId);
  }
}