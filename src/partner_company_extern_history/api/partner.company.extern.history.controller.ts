import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PartnerCompanyExternHistoryService } from '../application/partner.company.extern.history.service';
import { GetPartnerCompanyExternHistoryListReqDto } from './partner.company.extern.history.req.dto';
import {
  GetPartnerCompanyExternHistoryListResDto,
  GetPartnerCompanyTypesResDto,
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
}