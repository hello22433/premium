import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, Logger, Post, Put, Query, Res, UseFilters, UseGuards } from '@nestjs/common';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { AuthUserSuperAdminGuard } from '../../auth/api/auth.user.super-admin.guard';
import { SsgEventService } from '../application/ssg.event.service';
import {
  SsgEventGetListResDto,
  SsgEventGetValidListResDto,
  SsgReservationRangeViewResDto,
} from './ssg.event.res.dto';
import {
  SsgEventCreateReqDto,
  SsgEventExcelDownloadReqDto,
  SsgEventGetListReqDto,
  SsgEventGetValidListReqDto,
  SsgEventUpdateAmountReqDto,
  SsgReservationRangeUpdateReqDto,
} from './ssg.event.req.dto';
import * as fs from 'fs';
import { Response } from 'express';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { DownloadExceptionFilter } from '../../activity_log/api/download.exception.filter';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { AuthService } from '../../auth/application/auth.service';

@ApiTags('ssg-event')
@ApiBearerAuth()
@Controller('')
@UseGuards(AuthUserAuthorizationGuard)
export class SsgEventController {
  constructor(
    private ssgEventService: SsgEventService,
    private activityLogService: ActivityLogService,
    private authService: AuthService,
  ) {}

  private logger = new Logger('SSG_EVENT');

  @ApiOperation({
    summary: '신세계 행사 리스트 조회 API',
    description: '신세계 행사 리스트를 조회합니다.',
  })
  @ApiOkResponse({
    type: SsgEventGetListResDto,
    description: '성공적으로 조회한 경우',
  })
  // =====================================
  @Get('/ssg-event/list')
  async getList(@User() user: ILoginUserInfo, @Query() getQuery: SsgEventGetListReqDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.REFILL_SSG);
    return this.ssgEventService.getList(getQuery);
  }

  @ApiOperation({
    summary: '현재 유효한 신세계 행사 리스트 조회 API',
    description: '현재 날짜 기준으로 행사 기간이 유효하고 잔액이 있는 행사 리스트를 조회합니다.',
  })
  @ApiOkResponse({
    type: SsgEventGetValidListResDto,
    description: '성공적으로 조회한 경우',
  })
  // =====================================
  @Get('/ssg-event/valid-list')
  getValidList(@Query() getQuery: SsgEventGetValidListReqDto) {
    return this.ssgEventService.getValidList(getQuery);
  }

  @ApiOperation({
    summary: '신세계 행사 엑셀다운로드 API',
    description: '비밀번호 확인 후 엑셀 다운로드를 진행하며, 다운로드 사유와 함께 로그에 기록됩니다.',
  })
  @ApiOkResponse({
    type: '',
    description: '성공적으로 다운로드한 경우',
  })
  // =====================================
  @Post('/ssg-event/excel-download')
  @UseFilters(DownloadExceptionFilter)
  async excelDownload(
    @User() user: ILoginUserInfo,
    @Body() getBody: SsgEventExcelDownloadReqDto,
    @Res() res: Response,
  ) {
    const { fileName, filePath } = await this.ssgEventService.excelDownload(user, getBody);

    const encodedFileName = encodeURIComponent(fileName);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Content-Disposition', `attachment; filename=${encodedFileName}`);

    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

    fileStream.on('close', () => {
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) {
          this.logger.error(`파일 삭제 실패 ${unlinkErr}`);
        }
      });
    });
  }

  @ApiOperation({
    summary: '신세계 행사 생성 API',
  })
  @ApiOkResponse({
    description: '성공적으로 생성한 경우',
  })
  // =====================================
  @Post('/ssg-event')
  async create(@User() user: ILoginUserInfo, @Body() getBody: SsgEventCreateReqDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.REFILL_SSG);
    return this.ssgEventService.create(getBody);
  }

  @ApiOperation({
    summary: '신세계 행사 금액 충전',
    description: '금액을 충전합니다.',
  })
  @ApiOkResponse({
    description: '성공적으로 충전한 경우',
  })
  @ApiBadRequestResponse({
    description: '존재하지 않는 행사인 경우',
  })
  // =====================================
  @Put('/ssg-event/amount')
  async updateAmount(@User() user: ILoginUserInfo, @Body() getBody: SsgEventUpdateAmountReqDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.REFILL_SSG);
    return this.ssgEventService.updateAmount(getBody);
  }

  @ApiOperation({
    summary: 'SSG 예약발송 가능 범위 조회',
    description: '최고관리자가 설정한 SSG 예약발송 가능 시작일/종료일을 조회합니다. 미설정 시 null 반환',
  })
  @ApiOkResponse({
    type: SsgReservationRangeViewResDto,
    description: '성공적으로 조회한 경우',
  })
  // =====================================
  @Get('/ssg-event/reservation-range')
  getReservationRange(): Promise<SsgReservationRangeViewResDto> {
    return this.ssgEventService.getReservationRangeView();
  }

  @ApiOperation({
    summary: 'SSG 예약발송 가능 범위 설정',
    description: '최고관리자만 SSG 예약발송 가능 시작일/종료일을 설정할 수 있습니다.',
  })
  @ApiOkResponse({
    description: '성공적으로 설정한 경우',
  })
  @ApiBadRequestResponse({
    description: '종료일이 시작일보다 이전인 경우',
  })
  // =====================================
  @Put('/ssg-event/reservation-range')
  @UseGuards(AuthUserSuperAdminGuard)
  updateReservationRange(
    @User() user: ILoginUserInfo,
    @Body() getBody: SsgReservationRangeUpdateReqDto,
  ) {
    return this.ssgEventService.updateReservationRange(getBody.startDate, getBody.endDate, user.id);
  }

  @ApiOperation({
    summary: 'SSG 예약발송 가능 범위 해제',
    description:
      '최고관리자만 SSG 예약발송 가능 범위를 해제할 수 있습니다. 해제 후에는 폴백 정책(당월 말일까지)으로 동작합니다. 이미 미설정이어도 200 OK (멱등).',
  })
  @ApiOkResponse({
    description: '성공적으로 해제한 경우',
  })
  // =====================================
  @Delete('/ssg-event/reservation-range')
  @UseGuards(AuthUserSuperAdminGuard)
  deleteReservationRange() {
    return this.ssgEventService.deleteReservationRange();
  }
}
