import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
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
  UserManagementModifyBalanceReqDto,
  UserManagementGetCompanyListReqQueryDto,
  UserManagementModifyMaximumLimitReqDto,
  UserManagementChangeEmailReqDto,
} from './user.management.req.dto';
import {
  UserManagementBalanceViewDto,
  UserManagementGetDetailResDto,
  UserManagementGetListResDto,
  UserManagementGetNameListResDto,
  UserManagementGetBalanceHistoryResDto,
  UserManagementGetCompanyListResDto,
  UserManagementGetMaximumLimitHistoryResDto,
} from './user.management.res.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { AuthUserSuperAdminGuard } from '../../auth/api/auth.user.super-admin.guard';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { UserAuthSubEnum } from '../domain/user.auth.enum';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { AuthService } from '../../auth/application/auth.service';
import { User } from '../../auth/api/user.decorator';
import {
  AddAllowedIpReqDto,
  ApiKeyInfoResDto,
  CreateSsgRequestReqDto,
  DecideSsgRequestReqDto,
  GenerateApiKeyByAdminReqDto,
  GenerateApiKeyReqDto,
  SsgRequestResDto,
  UpdateAllowedIpsReqDto,
  UpdateApiKeySettingsReqDto,
} from './dto/user.management.api.key.dto';
import { IExternalApiSsgRequestStatus } from '../../external_api/interface/external.api.ssg.request.status';
import { IUserAuthority } from '../../user/interface/user.authority';

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
  async getNameList(@User() user: ILoginUserInfo, @Query() getQuery: UserManagementGetNameListReqQueryDto) {
    if (user.authority !== 'CORPORATE_ADMIN') {
      await this.authService.authorityValidator(user, UserAuthSubEnum.ACCOUNT);
    }
    return this.userManagementService.getNameList(getQuery, user);
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
  async getDetail(@User() user: ILoginUserInfo, @Param() getParam: UserManagementGetDetailReqParamDto) {
    if (user.authority === 'CORPORATE_ADMIN') {
      if (getParam.id !== user.id) {
        throw new ForbiddenException('권한이 없습니다.');
      }
    } else {
      await this.authService.authorityValidator(user, UserAuthSubEnum.ACCOUNT);
    }
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
  @UseGuards(AuthUserSuperAdminGuard)
  @Put('/user-management/balance')
  chargeBalance(@User() user: ILoginUserInfo, @Body() getBody: UserManagementChargeBalanceReqDto) {
    return this.userManagementService.chargeBalance(getBody, user);
  }

  @ApiOperation({
    summary: '계정 잔액 수정 API (최고관리자 전용)',
    description: '최고관리자만 접근 가능합니다. 잔액을 직접 수정합니다.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 수정한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 계정이 존재하지 않는 경우',
  })
  // ====================================
  @UseGuards(AuthUserSuperAdminGuard)
  @Put('/user-management/balance/modify')
  modifyBalance(@User() user: ILoginUserInfo, @Body() getBody: UserManagementModifyBalanceReqDto) {
    return this.userManagementService.modifyBalance(getBody, user);
  }

  @ApiOperation({ summary: '계정 잔액 조회 API' })
  @ApiBearerAuth()
  @ApiOkResponse({ type: UserManagementBalanceViewDto, description: '성공적으로 조회된 경우' })
  @ApiBadRequestResponse({ description: '해당 계정이 존재하지 않는 경우' })
  // ====================================
  @UseGuards(AuthUserAuthorizationGuard)
  @Get('/user-management/:id/balance')
  async getBalance(
    @User() user: ILoginUserInfo,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<UserManagementBalanceViewDto> {
    const isOwner = user.id === id;
    const isAdmin = user.authority === IUserAuthority.SUPER_ADMIN;
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('권한이 없습니다.');
    }
    const balance = await this.userManagementService.getBalance(id);
    return { balance };
  }

  @ApiOperation({
    summary: '계정 잔액 충전/수정 이력 조회 API',
    description: '해당 계정의 선충전 잔액 충전 및 수정 이력을 조회합니다.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    type: UserManagementGetBalanceHistoryResDto,
    description: '성공적으로 조회한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 계정이 존재하지 않는 경우',
  })
  // ====================================
  @UseGuards(AuthUserAuthorizationGuard)
  @Get('/user-management/:id/balance/history')
  getBalanceHistory(@User() user: ILoginUserInfo, @Param('id', ParseIntPipe) id: number) {
    const isOwner = user.id === id;
    const isAdmin = user.authority === IUserAuthority.SUPER_ADMIN;
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('권한이 없습니다.');
    }
    return this.userManagementService.getBalanceHistory(id);
  }

  @ApiOperation({
    summary: '최대서비스한도 변경 이력 조회 API',
    description: '해당 계정의 최대서비스한도(여신한도) 변경 이력을 조회합니다.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    type: UserManagementGetMaximumLimitHistoryResDto,
    description: '성공적으로 조회한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 계정이 존재하지 않는 경우',
  })
  // ====================================
  @UseGuards(AuthUserAuthorizationGuard)
  @Get('/user-management/:id/maximum-limit/history')
  getMaximumLimitHistory(@User() user: ILoginUserInfo, @Param('id', ParseIntPipe) id: number) {
    const isOwner = user.id === id;
    const isAdmin = user.authority === IUserAuthority.SUPER_ADMIN;
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('권한이 없습니다.');
    }
    return this.userManagementService.getMaximumLimitHistory(id);
  }

  @ApiOperation({
    summary: '최대서비스한도(여신한도) 수정 API',
    description: '최고관리자만 접근 가능합니다. 최대서비스한도를 직접 수정합니다.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 수정한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 계정이 존재하지 않거나 회사 정보가 없는 경우',
  })
  // ====================================
  @UseGuards(AuthUserSuperAdminGuard)
  @Put('/user-management/maximum-limit')
  modifyMaximumLimit(@User() user: ILoginUserInfo, @Body() getBody: UserManagementModifyMaximumLimitReqDto) {
    return this.userManagementService.modifyMaximumLimit(getBody, user);
  }

  @ApiOperation({
    summary: '계정 이메일(ID) 변경 API',
    description: '최고관리자만 접근 가능합니다. 계정의 로그인 이메일을 변경합니다.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 변경한 경우',
  })
  @ApiBadRequestResponse({
    description: '유저가 존재하지 않거나 이메일이 중복된 경우',
  })
  // ====================================
  @UseGuards(AuthUserSuperAdminGuard)
  @Put('/user-management/email')
  changeEmail(@Body() getBody: UserManagementChangeEmailReqDto) {
    return this.userManagementService.changeEmail(getBody);
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
  update(@User() user: ILoginUserInfo, @Body() getBody: UserManagementUpdateReqDto) {
    return this.userManagementService.update(getBody, user);
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

  @ApiOperation({
    summary: '고객사(회사) 목록 조회 API',
    description: 'user_company 테이블 기준으로 중복 없이 고객사 목록을 반환합니다.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    type: UserManagementGetCompanyListResDto,
    description: '성공적으로 불러온 경우',
  })
  // ====================================
  @UseGuards(AuthUserAuthorizationGuard)
  @Get('/user-management/company/list')
  async getCompanyList(@User() user: ILoginUserInfo, @Query() getQuery: UserManagementGetCompanyListReqQueryDto) {
    if (user.authority !== 'CORPORATE_ADMIN') {
      await this.authService.authorityValidator(user, UserAuthSubEnum.ACCOUNT);
    }
    return this.userManagementService.getCompanyList(getQuery, user);
  }

  // ─── 외부 API Key: 본인 ───────────────────────────────

  @Post('/user-management/me/api-key')
  @UseGuards(AuthUserAuthorizationGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[본인] 내 API Key 발급/재발급' })
  async generateMyApiKey(
    @User() user: ILoginUserInfo,
    @Body() body: GenerateApiKeyReqDto,
  ): Promise<{ apiKey: string }> {
    const apiKey = await this.userManagementService.generateApiKey(user.id, body, false);
    return { apiKey };
  }

  @Delete('/user-management/me/api-key')
  @UseGuards(AuthUserAuthorizationGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[본인] 내 API Key 비활성화' })
  async revokeMyApiKey(@User() user: ILoginUserInfo): Promise<void> {
    await this.userManagementService.revokeApiKey(user.id);
  }

  @Get('/user-management/me/api-key')
  @UseGuards(AuthUserAuthorizationGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[본인] 내 API Key 메타 조회 (raw key 노출 X)' })
  async getMyApiKeyInfo(@User() user: ILoginUserInfo): Promise<ApiKeyInfoResDto> {
    return this.userManagementService.getApiKeyInfo(user.id);
  }

  @Put('/user-management/me/api-key/allowed-ips')
  @UseGuards(AuthUserAuthorizationGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[본인] 내 API Key의 허용 IP 목록 통째 교체' })
  async replaceMyAllowedIps(@User() user: ILoginUserInfo, @Body() body: UpdateAllowedIpsReqDto): Promise<void> {
    await this.userManagementService.replaceAllowedIpsByUserId(user.id, body);
  }

  // ─── 외부 API Key: 어드민 ─────────────────────────────

  @Get('/user-management/:id/api-key')
  @UseGuards(AuthUserAuthorizationGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '특정 계정의 API Key 메타 조회 (본인 또는 어드민)' })
  async getApiKeyInfoById(
    @User() user: ILoginUserInfo,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ApiKeyInfoResDto> {
    const adminRoles = [IUserAuthority.SUPER_ADMIN, IUserAuthority.OPERATION_ADMIN];
    const isOwner = user.id === id;
    const isAdmin = adminRoles.includes(user.authority);

    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('권한이 없습니다.');
    }

    return this.userManagementService.getApiKeyInfo(id);
  }

  @Post('/user-management/:id/api-key')
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[어드민] 특정 계정의 API Key 발급/재발급' })
  async generateApiKey(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: GenerateApiKeyByAdminReqDto,
  ): Promise<{ apiKey: string }> {
    const apiKey = await this.userManagementService.generateApiKey(id, body, true);
    return { apiKey };
  }

  @Delete('/user-management/:id/api-key')
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[어드민] 특정 계정의 API Key 비활성화' })
  async revokeApiKey(@Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.userManagementService.revokeApiKey(id);
  }

  @Patch('/user-management/api-keys/:accountId')
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[어드민] API Key 설정 토글 (isActive/ssgEnabled/resendMaxCount)' })
  async updateApiKeySettings(
    @Param('accountId') accountId: string,
    @Body() body: UpdateApiKeySettingsReqDto,
  ): Promise<void> {
    await this.userManagementService.updateApiKeySettings(accountId, body);
  }

  @Put('/user-management/api-keys/:accountId/allowed-ips')
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[어드민] 특정 계정의 허용 IP 목록 통째 교체' })
  async replaceAllowedIps(@Param('accountId') accountId: string, @Body() body: UpdateAllowedIpsReqDto): Promise<void> {
    await this.userManagementService.replaceAllowedIps(accountId, body);
  }

  @Post('/user-management/me/api-key/allowed-ips')
  @UseGuards(AuthUserAuthorizationGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[본인] 내 API Key 허용 IP 단건 추가' })
  async addMyAllowedIp(@User() user: ILoginUserInfo, @Body() body: AddAllowedIpReqDto): Promise<{ id: string }> {
    return this.userManagementService.addAllowedIpByUserId(user.id, body);
  }

  @Delete('/user-management/me/api-key/allowed-ips/:ipId')
  @UseGuards(AuthUserAuthorizationGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[본인] 내 API Key 허용 IP 단건 삭제' })
  async deleteMyAllowedIp(@User() user: ILoginUserInfo, @Param('ipId') ipId: string): Promise<void> {
    await this.userManagementService.deleteAllowedIpByUserId(user.id, ipId);
  }

  @Post('/user-management/api-keys/:accountId/allowed-ips')
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[어드민] 특정 계정의 허용 IP 단건 추가' })
  async addAllowedIp(@Param('accountId') accountId: string, @Body() body: AddAllowedIpReqDto): Promise<{ id: string }> {
    return this.userManagementService.addAllowedIp(accountId, body);
  }

  @Delete('/user-management/api-keys/:accountId/allowed-ips/:ipId')
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[어드민] 특정 계정의 허용 IP 단건 삭제' })
  async deleteAllowedIp(@Param('accountId') accountId: string, @Param('ipId') ipId: string): Promise<void> {
    await this.userManagementService.deleteAllowedIp(accountId, ipId);
  }

  // ─── 외부 API Key: SSG 활성화 요청 ─────────────────────

  @Post('/user-management/me/api-key/ssg-requests')
  @UseGuards(AuthUserAuthorizationGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[본인] SSG 활성화 신청' })
  async createMySsgRequest(
    @User() user: ILoginUserInfo,
    @Body() body: CreateSsgRequestReqDto,
  ): Promise<SsgRequestResDto> {
    return this.userManagementService.createSsgRequest(user.id, body.reason);
  }

  @Delete('/user-management/me/api-key/ssg-requests/:requestId')
  @UseGuards(AuthUserAuthorizationGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[본인] SSG 활성화 신청 취소 (PENDING만)' })
  async cancelMySsgRequest(@User() user: ILoginUserInfo, @Param('requestId') requestId: string): Promise<void> {
    await this.userManagementService.cancelSsgRequest(user.id, requestId);
  }

  @Get('/user-management/me/api-key/ssg-requests')
  @UseGuards(AuthUserAuthorizationGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[본인] SSG 활성화 신청 이력 조회' })
  async listMySsgRequests(@User() user: ILoginUserInfo): Promise<SsgRequestResDto[]> {
    return this.userManagementService.getMySsgRequests(user.id);
  }

  @Get('/user-management/api-keys/ssg-requests')
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[어드민] SSG 활성화 신청 전체 조회' })
  async listSsgRequests(
    @Query('status') status?: IExternalApiSsgRequestStatus,
    @Query('accountId') accountId?: string,
  ): Promise<SsgRequestResDto[]> {
    return this.userManagementService.listSsgRequests({ status, accountId });
  }

  @Post('/user-management/api-keys/ssg-requests/:requestId/approve')
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[어드민] SSG 활성화 신청 승인' })
  async approveSsgRequest(
    @User() admin: ILoginUserInfo,
    @Param('requestId') requestId: string,
    @Body() body: DecideSsgRequestReqDto,
  ): Promise<SsgRequestResDto> {
    return this.userManagementService.approveSsgRequest(requestId, admin.id, body.note);
  }

  @Post('/user-management/api-keys/ssg-requests/:requestId/reject')
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[어드민] SSG 활성화 신청 거부' })
  async rejectSsgRequest(
    @User() admin: ILoginUserInfo,
    @Param('requestId') requestId: string,
    @Body() body: DecideSsgRequestReqDto,
  ): Promise<SsgRequestResDto> {
    return this.userManagementService.rejectSsgRequest(requestId, admin.id, body.note);
  }
}
