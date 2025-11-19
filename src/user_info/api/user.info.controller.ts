import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { UserInfoService } from '../application/user.info.service';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { UserInfoChangePasswordReqDto } from './user.info.req.dto';
import { User } from '../../auth/api/user.decorator';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { UserGetAuthListResDto } from './user.info.res.dto';

@ApiTags('user-info')
@Controller('')
export class UserInfoController {
  constructor(private userInfoService: UserInfoService) {}

  @ApiOperation({
    summary: '유저의 비밀번호 변경 API',
    description: '변경 완료 시 is password reset 이 false 로 변경됩니다.',
  })
  @ApiBearerAuth()
  // =================================================
  @UseGuards(AuthUserAuthorizationGuard)
  @Post('/user-info/change-password')
  async changePassword(@User() user: ILoginUserInfo, @Body() getBody: UserInfoChangePasswordReqDto) {
    return this.userInfoService.changePassword(user, getBody);
  }

  @ApiOperation({
    summary: '유저의 권한 불러오기 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    type: UserGetAuthListResDto,
    description: '권한조회',
  })
  // =================================================
  @UseGuards(AuthUserAuthorizationGuard)
  @Get('/user-info/auth-list')
  async getAuthList(@User() user: ILoginUserInfo) {
    return this.userInfoService.getAuthList(user);
  }
}
