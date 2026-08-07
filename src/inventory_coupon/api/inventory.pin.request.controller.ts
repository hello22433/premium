import {
  Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InventoryPinRequestService } from '../application/inventory.pin.request.service';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';

/**
 * 외부 API 재고형 쿠폰 신청/승인/정책 — user-management 경로. rev5 §11.6.
 */
@ApiTags('user-management')
@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
@Controller('user-management')
export class InventoryPinRequestController {
  constructor(private readonly requestService: InventoryPinRequestService) {}

  // ── 본인 신청 ──

  @Post('me/api-key/pin-inventory-requests')
  @ApiOperation({ summary: '재고형 쿠폰 사용 신청' })
  async submit(
    @Body() body: { reason: string },
    @User() user: ILoginUserInfo,
  ) {
    return this.requestService.submit(user.id, body.reason);
  }

  @Get('me/api-key/pin-inventory-requests')
  @ApiOperation({ summary: '내 신청 목록' })
  async myRequests(@User() user: ILoginUserInfo) {
    return this.requestService.listByUser(user.id);
  }

  @Delete('me/api-key/pin-inventory-requests/:requestId')
  @ApiOperation({ summary: '신청 취소 (본인 PENDING만)' })
  async cancel(
    @Param('requestId') requestId: string,
    @User() user: ILoginUserInfo,
  ) {
    return this.requestService.cancel(requestId, user.id);
  }

  // ── 관리자 ──

  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @Get('api-keys/pin-inventory-requests')
  @ApiOperation({ summary: '관리자: 전체 신청 목록' })
  async listAll() {
    return this.requestService.listAll();
  }

  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @Post('api-keys/pin-inventory-requests/:requestId/approve')
  @ApiOperation({ summary: '관리자: 신청 승인' })
  async approve(
    @Param('requestId') requestId: string,
    @Body() body: { reason?: string },
    @User() user: ILoginUserInfo,
  ) {
    return this.requestService.approve(requestId, user.id, body.reason);
  }

  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @Post('api-keys/pin-inventory-requests/:requestId/reject')
  @ApiOperation({ summary: '관리자: 신청 거절' })
  async reject(
    @Param('requestId') requestId: string,
    @Body() body: { reason: string },
    @User() user: ILoginUserInfo,
  ) {
    return this.requestService.reject(requestId, user.id, body.reason);
  }

  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @Post('api-apps/:appId/pin-inventory/revoke')
  @ApiOperation({ summary: '관리자: 승인 철회' })
  async revoke(
    @Param('appId') appId: string,
    @Body() body: { reason: string },
    @User() user: ILoginUserInfo,
  ) {
    return this.requestService.revoke(appId, user.id, body.reason);
  }

  @Get('api-apps/pin-inventory-policy')
  @ApiOperation({ summary: '정책 조회' })
  async getPolicy() {
    return this.requestService.getPolicy();
  }

  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @Patch('api-apps/pin-inventory-policy')
  @ApiOperation({ summary: '정책 토글' })
  async updatePolicy(
    @Body() body: {
      field: 'applicationsOpen' | 'allocationEnabled';
      value: boolean;
      expectedVersion: number;
    },
    @User() user: ILoginUserInfo,
  ) {
    return this.requestService.updatePolicy(
      body.field, body.value, body.expectedVersion, user.id,
    );
  }
}
