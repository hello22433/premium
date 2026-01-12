import { NoticeService } from '../application/notice.service';
import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  NoticeCreateReqDto,
  NoticeGetDetailReqParamDto,
  NoticeGetListReqQueryDto,
  NoticeUpdateReqDto,
} from './notice.req.dto';
import { NoticeGetDetailResDto, NoticeGetListResDto } from './notice.res.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { User } from '../../auth/api/user.decorator';
import { AuthService } from '../../auth/application/auth.service';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

@ApiTags('notice')
@Controller('')
@UseGuards(AuthUserAuthorizationGuard)
export class NoticeController {
  constructor(
    private noticeService: NoticeService,
    private authService: AuthService,
  ) {}

  @ApiOperation({
    summary: '공지사항 list API',
  })
  @ApiOkResponse({
    type: NoticeGetListResDto,
    description: '리스트 조회에 성공한 경우',
  })
  // ===================================================
  @Get('/notice/list')
  async getList(@User() user: ILoginUserInfo, @Query() getQuery: NoticeGetListReqQueryDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.NOTICE);
    return this.noticeService.getList(getQuery);
  }

  @ApiOperation({
    summary: '공지사항 detail API',
  })
  @ApiOkResponse({
    type: NoticeGetDetailResDto,
    description: '리스트 조회에 성공한 경우',
  })
  // ===================================================
  @Get('/notice/:id')
  getDetail(@Param() getParam: NoticeGetDetailReqParamDto) {
    return this.noticeService.getDetail(getParam);
  }

  @ApiOperation({
    summary: '공지사항 생성 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '공지사항 생성에 성공한 경우',
  })
  // ===================================================
  @UseGuards(AuthUserAuthorizationGuard)
  @Post('/notice')
  create(@User() user: ILoginUserInfo, @Body() getBody: NoticeCreateReqDto) {
    return this.noticeService.create(user, getBody);
  }

  @ApiOperation({
    summary: '공지사항 수정 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '공지사항 수정에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '공지사항이 존재하지 않는 경우',
  })
  // ===================================================
  @UseGuards(AuthUserAuthorizationGuard)
  @Put('/notice')
  update(@User() user: ILoginUserInfo, @Body() getBody: NoticeUpdateReqDto) {
    return this.noticeService.update(user, getBody);
  }

  @ApiOperation({
    summary: '공지사항 삭제 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '공지사항 삭제에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '공지사항이 존재하지 않는 경우',
  })
  // ===================================================
  @UseGuards(AuthUserAuthorizationGuard)
  @Delete('/notice/:id')
  delete(@User() user: ILoginUserInfo, @Param() getParam: NoticeGetDetailReqParamDto) {
    return this.noticeService.delete(user, getParam.id);
  }
}
