import { BadRequestException, Body, Controller, Get, Headers, Param, Post, Req } from '@nestjs/common';
import { UserService } from '../application/user.service';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  E2eSessionReqDto,
  UserExistEmailReqDto,
  UserGetAccessByRefreshReqDto,
  UserGetRefreshByRefreshReqDto,
  UserLoginByEmailPasswordReqDto,
  UserLoginEmailSendReqDto,
  UserLoginEmailVerifyReqDto,
  UserLoginPhoneSendReqDto,
  UserLoginPhoneVerifyReqDto,
  UserSignUpReqDto,
} from './user.req.dto';
import { ConfigService } from '@nestjs/config';
import {
  UserAccessByRefreshResDto,
  UserLoginByEmailPasswordResDto,
  UserLoginEmailResDto,
  UserLoginPhoneResDto,
  UserRefreshByRefreshResDto,
} from './user.res.dto';
import { Request } from 'express';

@ApiTags('user')
@Controller('')
export class UserController {
  constructor(
    private userService: UserService,
    private configService: ConfigService,
  ) {}

  @ApiOperation({
    summary: '이메일 중복 검사 API',
    description: '이메일를 입력받아 중복인지 확인합니다.',
  })
  @ApiResponse({
    type: Boolean,
    description: 'true => 중복한 이메일이 존재합니다. <br> ' + 'false => 중복한 이메일이 존재하지 않습니다.',
  })
  // ============================================
  @Get('/user/exist-email/:email')
  existEmail(@Param() param: UserExistEmailReqDto) {
    return this.userService.isExistEmail(param.email);
  }

  @ApiOperation({
    summary: '유저 이메일 회원가입 API',
    description:
      'body 정보들을 입력받아 회원가입을 진행합니다. <br>' + '이미 소셜로 가입하였다면 해당 회원가입은 불가능합니다.',
  })
  @ApiCreatedResponse()
  @ApiBadRequestResponse({
    description: '이메일(email) 이 이미 가입되어 있는 경우',
  })
  // ============================================
  @Post('/user/sign-up')
  signUp(@Body() signUpDto: UserSignUpReqDto) {
    return this.userService.signUp(signUpDto);
  }

  @ApiOperation({
    summary: '유저 email password API',
    description:
      '회원가입진행한 id password 를 통해 로그인을 진행합니다.<br>' +
      '금일 로그인 이메일 인증에 성공하지 못한경우 token 에 null을 반환합니다.',
  })
  @ApiOkResponse({
    type: UserLoginByEmailPasswordResDto,
    description: '로그인에 성공한 경우 토큰 발급',
  })
  @ApiBadRequestResponse({
    description: '이메일(email) 이 이미 가입되어 있는 경우<br>' + '비밀번호가 일치하지 않는 경우',
  })
  // ============================================
  @Post('/user/login-email-password')
  loginByEmailPassword(@Body() loginDto: UserLoginByEmailPasswordReqDto, @Req() req: Request) {
    return this.userService.loginByEmailPassword(loginDto, req.ip);
  }

  @ApiOperation({
    summary: '로그인 인증 이메일 전송 API',
  })
  @ApiOkResponse({
    type: UserLoginEmailResDto,
    description: '이메일 인증 전송 및 요청',
  })
  // ============================================
  @Post('/user/login/email/send')
  async loginEmailSend(@Body() getBody: UserLoginEmailSendReqDto): Promise<UserLoginEmailResDto> {
    return this.userService.loginEmailSend(getBody);
  }

  @ApiOperation({
    summary: '로그인 인증 이메일 인증 API',
  })
  @ApiOkResponse({
    description: '인증이 완료된 경우 다시 /user/login-email-password 를 호출해주세요.',
  })
  @ApiBadRequestResponse({
    description:
      '해당 id 이메일 데이터가 없는 경우 <br>' +
      '만료된 이메일 인증일 경우 <br>' +
      '코드가 일치하지 않을 경우 <br>' +
      '이미 인증 완료된 코드일경우',
  })
  // ============================================
  @Post('/user/login/email/verify')
  async loginEmailVerify(@Body() getBody: UserLoginEmailVerifyReqDto): Promise<void> {
    await this.userService.loginEmailVerify(getBody);
    return;
  }

  @ApiOperation({
    summary: '로그인 휴대번호 인증 전송 API',
    description: '등록된 담당자 연락처로 알림톡/SMS 인증코드를 발송합니다.',
  })
  @ApiOkResponse({
    type: UserLoginPhoneResDto,
    description: '휴대번호 인증코드 발송 성공',
  })
  @ApiBadRequestResponse({
    description: '유저가 존재하지 않는 경우<br>등록된 연락처가 없는 경우<br>인증코드 발송 실패',
  })
  // ============================================
  @Post('/user/login/phone/send')
  async loginPhoneSend(@Body() getBody: UserLoginPhoneSendReqDto): Promise<UserLoginPhoneResDto> {
    return this.userService.loginPhoneSend(getBody);
  }

  @ApiOperation({
    summary: '로그인 휴대번호 인증 검증 API',
    description: '알림톡/문자로 받은 인증코드를 검증합니다.',
  })
  @ApiOkResponse({
    description: '인증이 완료된 경우 다시 /user/login-email-password 를 호출해주세요.',
  })
  @ApiBadRequestResponse({
    description:
      '인증 데이터가 없는 경우<br>' +
      '만료된 인증 코드인 경우<br>' +
      '코드가 일치하지 않을 경우<br>' +
      '이미 인증 완료된 코드인 경우',
  })
  // ============================================
  @Post('/user/login/phone/verify')
  async loginPhoneVerify(@Body() getBody: UserLoginPhoneVerifyReqDto): Promise<void> {
    await this.userService.loginPhoneVerify(getBody);
    return;
  }

  @ApiOperation({
    summary: 'access 토큰 재발급 API',
    description: 'refresh token 을 활용하여 access 토큰 재발급 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    type: UserAccessByRefreshResDto,
    description: 'access 토큰 재발급 성공',
  })
  @ApiBadRequestResponse({
    description: 'refresh token 을 입력해 주세요.',
  })
  @ApiUnauthorizedResponse({
    description: '토큰이 만료되었습니다.<br>' + '토큰에 에러가 존재합니다.',
  })
  @ApiForbiddenResponse({
    description: '권한이 없습니다.',
  })
  @ApiInternalServerErrorResponse({
    description: '존재하지 않거나 삭제된 유저입니다.',
  })
  // ============================================
  @Post('/user/access-by-refresh')
  getAccessByRefresh(@Body() getBodyDto: UserGetAccessByRefreshReqDto) {
    return this.userService.getAccessByRefresh(getBodyDto.token);
  }

  @ApiOperation({
    summary: 'refresh 토큰 재발급 API',
    description: 'refresh token 을 활용하여 access 및 refresh 토큰 재발급 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    type: UserRefreshByRefreshResDto,
    description: 'access 및 refresh 토큰 재발급 성공',
  })
  @ApiBadRequestResponse({
    description: 'refresh token 을 입력해 주세요.',
  })
  @ApiUnauthorizedResponse({
    description: '토큰이 만료되었습니다.<br>' + '토큰에 에러가 존재합니다.',
  })
  @ApiForbiddenResponse({
    description: '권한이 없습니다.',
  })
  @ApiInternalServerErrorResponse({
    description: '존재하지 않거나 삭제된 유저입니다.',
  })
  // ============================================
  @Post('/user/refresh-by-refresh')
  getRefreshByToken(@Body() getBody: UserGetRefreshByRefreshReqDto) {
    return this.userService.getLoginTokenByRefresh(getBody.token);
  }

  // ============================================
  // E2E 테스트 전용 엔드포인트 (비상용 환경만)
  // ============================================

  @ApiOperation({
    summary: '[E2E] 테스트 전용 세션 bootstrap',
    description: '비상용 환경에서 allowlist E2E 계정에 대해 인증 과정 없이 토큰을 즉시 발급합니다.',
  })
  @ApiOkResponse({
    type: UserLoginByEmailPasswordResDto,
  })
  // ============================================
  @Post('/user/testing/e2e-session')
  e2eSession(
    @Body() body: E2eSessionReqDto,
    @Headers('x-e2e-secret') secret: string,
  ) {
    this.validateE2eSecret(secret);
    return this.userService.e2eSession(body.email);
  }

  @ApiOperation({
    summary: '[E2E] UI 로그인 smoke용 사전 인증 seed',
    description: '비상용 환경에서 allowlist E2E 계정의 오늘 로그인 인증 완료 상태를 주입합니다.',
  })
  @ApiOkResponse()
  // ============================================
  @Post('/user/testing/seed-login-verification')
  async e2eSeedLoginVerification(
    @Body() body: E2eSessionReqDto,
    @Headers('x-e2e-secret') secret: string,
  ) {
    this.validateE2eSecret(secret);
    await this.userService.e2eSeedLoginVerification(body.email);
    return;
  }

  private validateE2eSecret(secret: string): void {
    const expected = this.configService.get<string>('E2E_SECRET_KEY', '');
    if (!expected || secret !== expected) {
      throw new BadRequestException('INVALID_E2E_SECRET');
    }
  }
}
