import { Body, Controller, Post } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  UserFindIdReqDto,
  UserFindResetPasswordSendReqDto,
  UserFindResetPasswordVerifyReqDto,
} from './user.find.req.dto';
import { UserFindService } from '../application/user.find.service';
import { UserFindIdResDto, UserFindResetPasswordSendResDto } from './user.find.res.dto';

@ApiTags('user-find')
@Controller('')
export class UserFindController {
  constructor(private readonly userFindService: UserFindService) {}

  @ApiOperation({
    summary: '아이디(이메일) 찾기 API',
    description: '사업자번호, 이름, 휴대폰번호로 생성되어있는 email(Id) 을 return 합니다. ',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    type: UserFindIdResDto,
    description: 'email',
  })
  @ApiBadRequestResponse({
    description: '일치하는 이메일이 없습니다.',
  })
  // ============================================
  @Post('/user-find/id')
  async findId(@Body() getBody: UserFindIdReqDto): Promise<UserFindIdResDto> {
    return this.userFindService.findId(getBody);
  }

  @ApiOperation({
    summary: '비밀번호 찾기 시 이메일 전송 API',
    description: '임시비밀번호 설정을 위해 해당 이메일에 인증 코드를 전송합니다.',
  })
  @ApiOkResponse({
    type: UserFindResetPasswordSendResDto,
    description: '',
  })
  // ============================================
  @Post('/user-find/reset-password/send')
  async resetPasswordSend(@Body() getBody: UserFindResetPasswordSendReqDto): Promise<UserFindResetPasswordSendResDto> {
    return this.userFindService.resetPasswordSend(getBody);
  }

  @ApiOperation({
    summary: '비밀번호 찾기 시 이메일 인증코드 완료 및 임시비밀번호 전송 API',
    description: '전송에서 생성된 id와 이메일에 전송된 인증코드를 통해 해당 유저의 임시 비밀번호를 발급합니다.',
  })
  @ApiOkResponse({
    description: '임시 비밀번호가 성공적으로 전송된 경우',
  })
  @ApiBadRequestResponse({
    description:
      '해당 id 이메일 데이터가 없는 경우 <br>' +
      '만료된 이메일 인증일 경우 <br>' +
      '코드가 일치하지 않을 경우 <br>' +
      '이미 인증 완료된 코드일경우',
  })
  // ============================================
  @Post('/user-find/reset-password/verify')
  async resetPassword(@Body() getBody: UserFindResetPasswordVerifyReqDto): Promise<void> {
    await this.userFindService.resetPasswordVerify(getBody);
  }
}
