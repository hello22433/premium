import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { UserDriveService } from '../application/user.drive.service';
import {
  UserDriveCreateReqDto,
  UserDriveGetDetailReqParamDto,
  UserDriveGetListReqDto,
  UserDriveUpdateReqDto,
} from './user.drive.req.dto';
import { UserDriveGetDetailResDto, UserDriveGetListResDto } from './user.drive.res.dto';

@ApiTags('user-drive')
@ApiBearerAuth()
@Controller('')
@UseGuards(AuthUserAuthorizationGuard)
export class UserDriveController {
  constructor(private userDriveService: UserDriveService) {}

  @ApiOperation({
    summary: '문서함 list API',
    description: '기업관리자인 경우 자신에게 온 문서만 조회, 운영/최고관리자는 모두 조회 됩니다.',
  })
  @ApiOkResponse({
    type: UserDriveGetListResDto,
    description: '리스트 조회에 성공한 경우',
  })
  // ===================================================
  @Get('/user-drive/list')
  getList(@User() user: ILoginUserInfo, @Query() getQuery: UserDriveGetListReqDto) {
    return this.userDriveService.getList(user, getQuery);
  }

  @ApiOperation({
    summary: '문서함 문서 상세 조회 API',
    description: '기업관리자인 경우 자신에게 온 문서만 상세조회 가능하며, 운영/최고관리자는 모두 상세조회 됩니다.',
  })
  @ApiOkResponse({
    type: UserDriveGetDetailResDto,
    description: '리스트 조회에 성공한 경우',
  })
  // ===================================================
  @Get('/user-drive/:id')
  getDetail(@User() user: ILoginUserInfo, @Param() getParam: UserDriveGetDetailReqParamDto) {
    return this.userDriveService.getDetail(user, getParam);
  }

  @ApiOperation({
    summary: '문서 생성 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '문서 생성에 성공한 경우',
  })
  // ===================================================
  @UseGuards(AuthUserAuthorizationGuard)
  @Post('/user-drive')
  create(@User() user: ILoginUserInfo, @Body() getBody: UserDriveCreateReqDto) {
    return this.userDriveService.create(user, getBody);
  }

  @ApiOperation({
    summary: '문서 수정 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '문서 수정에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '문서가 존재하지 않는 경우',
  })
  // ===================================================
  @UseGuards(AuthUserAuthorizationGuard)
  @Put('/user-drive')
  update(@User() user: ILoginUserInfo, @Body() getBody: UserDriveUpdateReqDto) {
    return this.userDriveService.update(user, getBody);
  }
}
