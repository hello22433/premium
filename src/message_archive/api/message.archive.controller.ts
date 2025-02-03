import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { MessageArchiveService } from '../application/message.archive.service';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { User } from '../../auth/api/user.decorator';
import { MessageArchiveGetListResDto } from './message.archive.res.dto';
import { MessageArchiveCreateReqDto, MessageArchiveGetListReqQueryDto } from './message.archive.req.dto';

@ApiTags('message-archive')
@ApiBearerAuth()
@Controller('')
@UseGuards(AuthUserAuthorizationGuard)
export class MessageArchiveController {
  constructor(private messageArchiveService: MessageArchiveService) {}

  @ApiOperation({
    summary: '문자 보관함 불러오기 list API',
  })
  @ApiOkResponse({
    type: MessageArchiveGetListResDto,
    description: '성공적으로 조회한 경우',
  })
  // ===========================================
  @Get('/message-archive/list')
  getList(@User() user: ILoginUserInfo, @Query() getQuery: MessageArchiveGetListReqQueryDto) {
    return this.messageArchiveService.getList(user, getQuery);
  }

  @ApiOperation({
    summary: '문자 보관함 생성하기 API',
  })
  @ApiOkResponse({
    description: '성공적으로 생성한 경우',
  })
  // ===========================================
  @Post('/message-archive')
  create(@User() user: ILoginUserInfo, @Body() getBody: MessageArchiveCreateReqDto) {
    return this.messageArchiveService.create(user, getBody);
  }
}
