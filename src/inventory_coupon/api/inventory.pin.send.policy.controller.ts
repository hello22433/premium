import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InventoryPinPolicyService } from '../application/inventory.pin.policy.service';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';

/**
 * 직접 PIN 발송 정책 (send-stop) 관리 API.
 * allocation 정책과 독립: send_enabled가 false이면 CLAIMED 전 PIN decrypt/mail I/O를 차단.
 */
@ApiTags('inventory-coupons')
@ApiBearerAuth()
@UseGuards(AuthUserSuperAndOperationAdminGuard)
@Controller('inventory-coupons/send-policy')
export class InventoryPinSendPolicyController {
  constructor(private readonly policyService: InventoryPinPolicyService) {}

  @Get()
  @ApiOperation({ summary: '직접 PIN 발송 정책 조회' })
  async getSendPolicy() {
    return this.policyService.readSendPolicy();
  }

  @Patch()
  @ApiOperation({ summary: '직접 PIN 발송 정책 토글 (send-stop)' })
  async toggleSendPolicy(
    @Body() body: {
      sendEnabled: boolean;
      expectedVersion: number;
      reason: string;
    },
    @User() user: ILoginUserInfo,
  ) {
    return this.policyService.toggleSendPolicy(
      body.sendEnabled,
      body.expectedVersion,
      user.id,
      body.reason,
    );
  }
}
