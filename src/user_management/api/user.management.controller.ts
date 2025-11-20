import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserManagementService } from '../application/user.management.service';
import {
  UserManagementChargeBalanceReqDto,
  UserManagementCreateReqDto,
  UserManagementGetDetailReqParamDto,
  UserManagementGetListReqQueryDto,
  UserManagementGetNameListReqQueryDto,
  UserManagementPasswordResetReqDto,
  UserManagementUpdateReqDto,
} from './user.management.req.dto';
import {
  UserManagementBalanceViewDto,
  UserManagementGetDetailResDto,
  UserManagementGetListResDto,
  UserManagementGetNameListResDto,
} from './user.management.res.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { AuthUserSuperAdminGuard } from '../../auth/api/auth.user.super-admin.guard';
import { UserAuthSubEnum } from '../domain/user.auth.enum';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { AuthService } from '../../auth/application/auth.service';
import { User } from '../../auth/api/user.decorator';

@ApiTags('user-management')
@Controller('')
export class UserManagementController {
  constructor(
    private userManagementService: UserManagementService,
    private authService: AuthService,
  ) {}

  @ApiOperation({
    summary: '고객사 이름 list 불러오기 API',
    description: '주문관리, 발송관리 등에서 list 를 불러오고자 할 경우<br>' + '아무것도 주지 않을시 전체를 조회합니다.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    type: UserManagementGetNameListResDto,
    description: '성공적으로 불러온 경우',
  })
  // ====================================
  @UseGuards(AuthUserAuthorizationGuard)
  @Get('/user-management/name/list')
  getNameList(@Query() getQuery: UserManagementGetNameListReqQueryDto) {
    return this.userManagementService.getNameList(getQuery);
  }

  @ApiOperation({
    summary: '계정 관리 list 불러오기 API',
    description: '고객 list 를 받은 경우',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    type: UserManagementGetListResDto,
    description: '성공적으로 불러온 경우',
  })
  // ====================================
  @UseGuards(AuthUserAuthorizationGuard)
  @Get('/user-management/list')
  async getList(@User() user: ILoginUserInfo, @Query() getQuery: UserManagementGetListReqQueryDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ACCOUNT);
    return this.userManagementService.getList(getQuery);
  }

  @ApiOperation({
    summary: '계정 관리 상세 조회 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    type: UserManagementGetDetailResDto,
    description: '성공적으로 불러온 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 계정이 존재하지 않는 경우',
  })
  // ====================================
  @UseGuards(AuthUserAuthorizationGuard)
  @Get('/user-management/detail/:id')
  getDetail(@Param() getParam: UserManagementGetDetailReqParamDto) {
    return this.userManagementService.getDetail(getParam);
  }

  @ApiOperation({
    summary: '계정 잔액 충전 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 충전한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 계정이 존재하지 않는 경우',
  })
  // ====================================
  @UseGuards(AuthUserAuthorizationGuard)
  @Put('/user-management/balance')
  chargeBalance(@Body() getBody: UserManagementChargeBalanceReqDto) {
    return this.userManagementService.chargeBalance(getBody);
  }

  @ApiOperation({ summary: '계정 잔액 조회 API' })
  @ApiBearerAuth()
  @ApiOkResponse({ type: UserManagementBalanceViewDto, description: '성공적으로 조회된 경우' })
  @ApiBadRequestResponse({ description: '해당 계정이 존재하지 않는 경우' })
  // ====================================
  @Get('/user-management/:id/balance')
  async getBalance(@Param('id', ParseIntPipe) id: number): Promise<UserManagementBalanceViewDto> {
    const balance = await this.userManagementService.getBalance(id);
    return { balance };
  }

  @ApiOperation({
    summary: '계정 관리 신규 등록 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 생성 한 경우',
  })
  @ApiBadRequestResponse({
    description: '중복된 이메일이 존재하는 경우',
  })
  // ====================================
  @UseGuards(AuthUserSuperAdminGuard)
  @Post('/user-management')
  create(@Body() getBody: UserManagementCreateReqDto) {
    return this.userManagementService.create(getBody);
  }

  @ApiOperation({
    summary: '계정 수정 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 생성 한 경우',
  })
  @ApiBadRequestResponse({
    description: '중복된 이메일이 존재하는 경우',
  })
  // ====================================
  @UseGuards(AuthUserSuperAdminGuard)
  @Put('/user-management')
  update(@Body() getBody: UserManagementUpdateReqDto) {
    return this.userManagementService.update(getBody);
  }

  @ApiOperation({
    summary: '계정 비밀번호 초기화 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 초기화 한 경우',
  })
  // ====================================
  @UseGuards(AuthUserSuperAdminGuard)
  @Post('/user-management/password-reset')
  passwordReset(@Body() getBody: UserManagementPasswordResetReqDto) {
    return this.userManagementService.passwordReset(getBody);
  }
}
