import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserTaskHistoryService } from '../application/user.task.history.service';
import { UserTaskHistoryGetDetailResDto, UserTaskHistoryGetListResDto } from './user.task.history.res.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import {
  UserTaskHistoryCreateReqDto,
  UserTaskHistoryDeleteReqDto,
  UserTaskHistoryGetDetailReqParamDto,
  UserTaskHistoryGetListReqQueryDto,
} from './user.task.history.req.dto';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { User } from '../../auth/api/user.decorator';

@ApiTags('user-task-history')
@Controller('')
export class UserTaskHistoryController {
  constructor(private readonly userTaskHistoryService: UserTaskHistoryService) {}

  @ApiOperation({
    summary: '고객관리-고객관리 목록 불러오기 API',
    description: '고객관리 리스트를 받은 경우',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    type: UserTaskHistoryGetListResDto,
    description: '성공적으로 불러온 경우',
  })
  @UseGuards(AuthUserAuthorizationGuard)
  // ====================================
  @Get('/user-task-history/list')
  getList(@User() user: ILoginUserInfo, @Query() getQuery: UserTaskHistoryGetListReqQueryDto) {
    return this.userTaskHistoryService.getList(user, getQuery);
  }

  @ApiOperation({
    summary: '고객관리 상세 상담내역 리스트 불러오기 API',
    description: '특정 유저의 상담내역 리스트를 가져온 경우',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    type: UserTaskHistoryGetDetailResDto,
    description: '성공적으로 불러온 경우',
  })
  @UseGuards(AuthUserAuthorizationGuard)
  // ====================================
  @Get('/user-task-history/detail/:id')
  getDetail(@User() user: ILoginUserInfo, @Param() getParam: UserTaskHistoryGetDetailReqParamDto) {
    return this.userTaskHistoryService.getDetail(user, getParam);
  }

  @ApiOperation({
    summary: '고개관리 상담내역 등록 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '상담내역 등록에 성공한 경우',
  })
  // ===================================================
  @UseGuards(AuthUserAuthorizationGuard)
  @Post('/user-task-history')
  create(@User() user: ILoginUserInfo, @Body() getBody: UserTaskHistoryCreateReqDto) {
    return this.userTaskHistoryService.create(user, getBody);
  }

  @ApiOperation({
    summary: '상담내역 소프트 삭제 API',
    description: '유저 상담내역을 소프트 삭제',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 삭제한 경우',
  })
  @UseGuards(AuthUserAuthorizationGuard)
  // ===================================================
  @Delete('/user-task-history')
  delete(@User() user: ILoginUserInfo, @Body() deleteBody: UserTaskHistoryDeleteReqDto) {
    return this.userTaskHistoryService.delete(user, deleteBody);
  }
}
