import { Body, Controller, Delete, Get, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { OrderFromService } from '../application/order.from.service';
import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { AuthUserSuperAdminGuard } from '../../auth/api/auth.user.super-admin.guard';
import {
  OrderFromAdminListResDto,
  OrderFromGetEmailListResDto,
  OrderFromGetPhoneListResDto,
  OrderFromPhoneManageListResDto,
} from './order.from.res.dto';
import {
  OrderFromAdminApproveReqDto,
  OrderFromAdminDeleteReqDto,
  OrderFromAdminGetListReqDto,
  OrderFromAdminRejectReqDto,
  OrderFromAdminUpdateCertReqDto,
  OrderFromCreateEmailReqDto,
  OrderFromCreatePhoneReqDto,
  OrderFromDeleteEmailReqDto,
  OrderFromGetPhoneReqQueryDto,
  OrderFromSetDefaultReqDto,
  OrderFromSetHideSystemReqDto,
} from './order.from.req.dto';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';

@ApiTags('order-from')
@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
@Controller('')
export class OrderFromController {
  constructor(private orderFromService: OrderFromService) {}

  @ApiOperation({ summary: '발신 핸드폰 번호 리스트 불러오기 (승인된 번호, 발송용)' })
  @ApiOkResponse({ type: OrderFromGetPhoneListResDto })
  // ====================================================
  @Get('/order-from/phone/list')
  getPhoneList(@User() user: ILoginUserInfo, @Query() getQuery: OrderFromGetPhoneReqQueryDto) {
    return this.orderFromService.getPhoneList(user, getQuery);
  }

  @ApiOperation({ summary: '발신번호 관리 리스트 (모든 상태, 관리탭용)' })
  @ApiOkResponse({ type: OrderFromPhoneManageListResDto })
  // ====================================================
  @Get('/order-from/phone/manage-list')
  getPhoneManageList(@User() user: ILoginUserInfo) {
    return this.orderFromService.getPhoneManageList(user);
  }

  @ApiOperation({ summary: '발신 핸드폰 번호 추가하기' })
  @ApiOkResponse({ description: '성공적으로 추가한 경우' })
  @ApiBadRequestResponse({ description: '이미 등록된 발신번호가 존재할경우' })
  // ====================================================
  @Post('/order-from/phone')
  createPhone(@User() user: ILoginUserInfo, @Body() getBody: OrderFromCreatePhoneReqDto) {
    return this.orderFromService.createPhone(user, getBody);
  }

  @ApiOperation({ summary: '발신 이메일 리스트 불러오기' })
  @ApiOkResponse({ type: OrderFromGetEmailListResDto })
  // ====================================================
  @Get('/order-from/email/list')
  getEmailList() {
    return this.orderFromService.getEmailList();
  }

  @ApiOperation({ summary: '발신 이메일 추가하기' })
  @ApiOkResponse({ description: '성공적으로 추가한 경우' })
  @ApiBadRequestResponse({ description: '이미 등록된 이메일이 존재할경우 <br>등록할 수 없는 이메일 id 일 경우' })
  // ====================================================
  @Post('/order-from/email')
  createEmail(@Body() getBody: OrderFromCreateEmailReqDto) {
    return this.orderFromService.createEmail(getBody);
  }

  @ApiOperation({ summary: '발신 이메일 삭제하기' })
  @ApiOkResponse({ description: '성공적으로 삭제한 경우' })
  @ApiBadRequestResponse({ description: '존재하지 않는 이메일일 경우' })
  // ====================================================
  @Delete('/order-from/email')
  deleteEmail(@Body() getBody: OrderFromDeleteEmailReqDto) {
    return this.orderFromService.deleteEmail(getBody.id);
  }

  @ApiOperation({ summary: '기본 발신번호 설정' })
  @ApiOkResponse({ description: '성공적으로 설정한 경우' })
  @ApiBadRequestResponse({ description: '존재하지 않는 발신번호일 경우' })
  // ====================================================
  @Patch('/order-from/phone/default')
  setDefault(@User() user: ILoginUserInfo, @Body() getBody: OrderFromSetDefaultReqDto) {
    return this.orderFromService.setDefault(user, getBody);
  }

  @ApiOperation({ summary: '시스템 기본번호(1644-3614) MMS 선택목록 숨김 설정' })
  @ApiOkResponse({ description: '성공적으로 설정한 경우' })
  @ApiBadRequestResponse({ description: '존재하지 않는 사용자일 경우' })
  // ====================================================
  @Patch('/order-from/phone/hide-system')
  setHideSystemFromPhone(@User() user: ILoginUserInfo, @Body() getBody: OrderFromSetHideSystemReqDto) {
    return this.orderFromService.setHideSystemFromPhone(user, getBody);
  }

  // ==================== 관리자용 API ====================

  @ApiOperation({ summary: '[관리자] 발신번호 전체 조회 (PENDING/APPROVED)' })
  @ApiOkResponse({ type: OrderFromAdminListResDto })
  // ====================================================
  @UseGuards(AuthUserSuperAdminGuard)
  @Get('/order-from/admin/list')
  getAdminList(@Query() getQuery: OrderFromAdminGetListReqDto) {
    return this.orderFromService.getAdminList(getQuery);
  }

  @ApiOperation({ summary: '[관리자] 발신번호 삭제' })
  @ApiOkResponse({ description: '성공적으로 삭제한 경우' })
  @ApiBadRequestResponse({ description: '존재하지 않는 발신번호/이메일일 경우' })
  // ====================================================
  @UseGuards(AuthUserSuperAdminGuard)
  @Delete('/order-from/admin')
  adminDelete(@Body() getBody: OrderFromAdminDeleteReqDto) {
    return this.orderFromService.adminDelete(getBody.id);
  }

  @ApiOperation({ summary: '[관리자] 발신번호 승인 (PENDING → APPROVED)' })
  @ApiOkResponse({ description: '성공적으로 승인한 경우' })
  @ApiBadRequestResponse({ description: '승인할 수 있는 요청이 없는 경우' })
  // ====================================================
  @UseGuards(AuthUserSuperAdminGuard)
  @Patch('/order-from/admin/approve')
  adminApprove(@Body() getBody: OrderFromAdminApproveReqDto) {
    return this.orderFromService.adminApprove(getBody.id);
  }

  @ApiOperation({ summary: '[관리자] 발신번호 거절 (PENDING → REJECTED), 거절 사유 포함' })
  @ApiOkResponse({ description: '성공적으로 거절한 경우' })
  @ApiBadRequestResponse({ description: '거절할 수 있는 요청이 없는 경우' })
  // ====================================================
  @UseGuards(AuthUserSuperAdminGuard)
  @Patch('/order-from/admin/reject')
  adminReject(@Body() getBody: OrderFromAdminRejectReqDto) {
    return this.orderFromService.adminReject(getBody.id, getBody.rejectReason);
  }

  @ApiOperation({ summary: '[관리자] 통신이용증명 파일/유형 업데이트' })
  @ApiOkResponse({ description: '성공적으로 업데이트한 경우' })
  @ApiBadRequestResponse({ description: '존재하지 않는 발신번호일 경우' })
  // ====================================================
  @UseGuards(AuthUserSuperAdminGuard)
  @Patch('/order-from/admin/cert')
  adminUpdateCert(@Body() getBody: OrderFromAdminUpdateCertReqDto) {
    return this.orderFromService.adminUpdateCert(getBody);
  }
}
