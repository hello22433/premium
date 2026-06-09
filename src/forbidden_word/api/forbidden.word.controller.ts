import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ForbiddenWordService } from '../application/forbidden.word.service';
import {
  ForbiddenWordCreateReqDto,
  ForbiddenWordDeleteReqDto,
  ForbiddenWordGetBlockLogReqQueryDto,
  ForbiddenWordGetHistoryReqQueryDto,
  ForbiddenWordGetListReqQueryDto,
  ForbiddenWordIdParamDto,
  ForbiddenWordUpdateReqDto,
} from './forbidden.word.req.dto';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';

@ApiTags('forbidden-word')
@Controller('')
@ApiBearerAuth()
@UseGuards(AuthUserSuperAndOperationAdminGuard)
export class ForbiddenWordController {
  constructor(private readonly forbiddenWordService: ForbiddenWordService) {}

  @ApiOperation({ summary: '금칙어 목록 조회 API (검색/카테고리/활성 필터, 페이징)' })
  @ApiOkResponse({ description: '목록 조회 성공' })
  @Get('/forbidden-word')
  async getList(@Query() getQuery: ForbiddenWordGetListReqQueryDto) {
    return this.forbiddenWordService.getList(getQuery);
  }

  @ApiOperation({ summary: '금칙어 변경 이력 조회 API' })
  @ApiOkResponse({ description: '이력 조회 성공' })
  @Get('/forbidden-word/history')
  async getHistory(@Query() getQuery: ForbiddenWordGetHistoryReqQueryDto) {
    return this.forbiddenWordService.getHistory(getQuery);
  }

  @ApiOperation({ summary: '금칙어 차단 로그 조회 API (운영화면용)' })
  @ApiOkResponse({ description: '차단 로그 조회 성공' })
  @Get('/forbidden-word/block-log')
  async getBlockLog(@Query() getQuery: ForbiddenWordGetBlockLogReqQueryDto) {
    return this.forbiddenWordService.getBlockLog(getQuery);
  }

  @ApiOperation({ summary: '금칙어 추가 API' })
  @ApiOkResponse({ description: '금칙어 추가 성공' })
  @Post('/forbidden-word')
  async create(@User() user: ILoginUserInfo, @Body() getBody: ForbiddenWordCreateReqDto) {
    return this.forbiddenWordService.create(user, getBody);
  }

  @ApiOperation({ summary: '금칙어 수정 API' })
  @ApiOkResponse({ description: '금칙어 수정 성공' })
  @Put('/forbidden-word/:id')
  async update(
    @User() user: ILoginUserInfo,
    @Param() getParam: ForbiddenWordIdParamDto,
    @Body() getBody: ForbiddenWordUpdateReqDto,
  ) {
    return this.forbiddenWordService.update(user, getParam.id, getBody);
  }

  @ApiOperation({ summary: '금칙어 삭제 API' })
  @ApiOkResponse({ description: '금칙어 삭제 성공' })
  @Delete('/forbidden-word/:id')
  async delete(
    @User() user: ILoginUserInfo,
    @Param() getParam: ForbiddenWordIdParamDto,
    @Body() getBody: ForbiddenWordDeleteReqDto,
  ) {
    return this.forbiddenWordService.delete(user, getParam.id, getBody.reason ?? null);
  }
}
