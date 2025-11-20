import { Controller, Get, Post, Query, Body, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { ActivityLogService } from '../application/activity.log.service';
import { GetActivityLogListReqDto, DownloadActivityLogExcelReqDto } from './activity.log.req.dto';
import { GetActivityLogListResDto, GetActionTypesResDto } from './activity.log.res.dto';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { ActivityLogResult } from '../interface/activity.log.result';
import { AuthService } from '../../auth/application/auth.service';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

@Controller('')
@ApiTags('activity-log')
@ApiBearerAuth()
@UseGuards(AuthUserSuperAndOperationAdminGuard)
export class ActivityLogController {
  constructor(
    private activityLogService: ActivityLogService,
    private authService: AuthService,
  ) {}

  @ApiOperation({
    description: '활동 로그 목록 조회 API',
  })
  @ApiOkResponse({
    type: GetActivityLogListResDto,
    description: '성공적으로 조회한 경우',
  })
  @Get('/activity-log/list')
  async getList(
    @User() user: ILoginUserInfo,
    @Query() dto: GetActivityLogListReqDto,
  ): Promise<GetActivityLogListResDto> {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ACTIVITY_LOG);
    return this.activityLogService.getActivityLogList(dto);
  }

  @ApiOperation({
    description: '액션 타입 목록 조회 API (드롭박스용)',
  })
  @ApiOkResponse({
    type: GetActionTypesResDto,
    description: '성공적으로 조회한 경우',
  })
  @Get('/activity-log/action-types')
  async getActionTypes(): Promise<GetActionTypesResDto> {
    return this.activityLogService.getActionTypes();
  }

  @ApiOperation({
    description: '활동 로그 엑셀 다운로드 API',
  })
  @Post('/activity-log/excel-download')
  async downloadExcel(
    @Body() dto: DownloadActivityLogExcelReqDto,
    @Res() res: Response,
    @User() user: ILoginUserInfo,
  ): Promise<void> {
    // 엑셀 다운로드 로그 기록
    await this.activityLogService.createLog({
      userId: user.id,
      userEmail: user.email,
      method: 'POST',
      requestUrl: '/activity-log/excel-download',
      actionType: 'EXCEL_DOWNLOAD',
      ipAddress: res.req.ip || '',
      userAgent: res.req.headers['user-agent'],
      statusCode: 200,
      result: ActivityLogResult.SUCCESS,
      responseTime: 0,
      downloadReason: dto.downloadReason,
      requestParams: {
        startAt: dto.startAt,
        endAt: dto.endAt,
        actionType: dto.actionType,
        searchKeyword: dto.searchKeyword,
      },
    });

    return this.activityLogService.downloadActivityLogExcel(dto, res);
  }
}
