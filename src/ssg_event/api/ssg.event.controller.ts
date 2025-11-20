import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Logger, Post, Put, Query, Res, UseFilters, UseGuards } from '@nestjs/common';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { SsgEventService } from '../application/ssg.event.service';
import { SsgEventGetListResDto, SsgEventGetValidListResDto } from './ssg.event.res.dto';
import {
  SsgEventCreateReqDto,
  SsgEventExcelDownloadReqDto,
  SsgEventGetListReqDto,
  SsgEventGetValidListReqDto,
  SsgEventUpdateAmountReqDto,
} from './ssg.event.req.dto';
import * as fs from 'fs';
import { Response } from 'express';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { DownloadExceptionFilter } from '../../activity_log/api/download.exception.filter';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';

@ApiTags('ssg-event')
@ApiBearerAuth()
@Controller('')
@UseGuards(AuthUserAuthorizationGuard)
export class SsgEventController {
  constructor(
    private ssgEventService: SsgEventService,
    private activityLogService: ActivityLogService,
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
  getList(@Query() getQuery: SsgEventGetListReqDto) {
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
    try {
      const { fileName, filePath } = await this.ssgEventService.excelDownload(user, getBody);

      const encodedFileName = encodeURIComponent(fileName);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      res.setHeader('Content-Disposition', `attachment; filename=${encodedFileName}`);

      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);

      fileStream.on('close', async () => {
        fs.unlink(filePath, (unlinkErr) => {
          if (unlinkErr) {
            this.logger.error(`파일 삭제 실패 ${unlinkErr}`);
          }
        });
      });
    } catch (e) {
      throw e;
    }
  }

  @ApiOperation({
    summary: '신세계 행사 생성 API',
  })
  @ApiOkResponse({
    description: '성공적으로 생성한 경우',
  })
  // =====================================
  @Post('/ssg-event')
  create(@Body() getBody: SsgEventCreateReqDto) {
    return this.ssgEventService.create(getBody);
  }

  /* 충전 기능 미사용으로 주석처리
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
  updateAmount(@Body() getBody: SsgEventUpdateAmountReqDto) {
    return this.ssgEventService.updateAmount(getBody);
  }
  */
}
