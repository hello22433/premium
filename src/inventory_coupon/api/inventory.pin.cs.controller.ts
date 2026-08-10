import { Body, Controller, Header, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InventoryPinCsService } from '../application/inventory.pin.cs.service';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';

@ApiTags('customer-service')
@ApiBearerAuth()
@UseGuards(AuthUserSuperAndOperationAdminGuard)
@Controller('customer-service/inventory-pin')
export class InventoryPinCsController {
  constructor(
    private readonly csService: InventoryPinCsService,
  ) {}

  @Post('reveal')
  // PIN 원문 응답은 중간 프록시·브라우저 디스크 캐시에 남으면 안 된다 (rev5 §7.3).
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'PIN 원문 확인 (사유 기반, no-store)' })
  async revealPin(
    @Body() body: { orderDeliveryId: number; reason: string },
    @User() user: ILoginUserInfo,
  ) {
    return this.csService.revealPin(body.orderDeliveryId, body.reason, user.id);
  }

  @Post('resend')
  @ApiOperation({ summary: '동일 PIN 재발송' })
  async resend(
    @Body() body: { orderDeliveryId: number; requestKey: string },
    @User() user: ILoginUserInfo,
  ) {
    return this.csService.resendSamePin(body.orderDeliveryId, body.requestKey, user.id);
  }

  @Post('terminal-cancel-refund')
  @ApiOperation({ summary: '관리자 terminal 취소+환불' })
  async terminalCancelRefund(
    @Body() body: { orderDeliveryId: number; reason: string },
    @User() user: ILoginUserInfo,
  ) {
    return this.csService.terminalCancelRefund(body.orderDeliveryId, body.reason, user.id);
  }

  @Post('void-and-reissue')
  @ApiOperation({ summary: '폐기 후 신규 발송 (재발급)' })
  async voidAndReissue(
    @Body() body: {
      orderDeliveryId: number;
      reason: string;
      newRecipientEmail?: string;
    },
    @User() user: ILoginUserInfo,
  ) {
    return this.csService.voidAndReissue(
      body.orderDeliveryId,
      body.reason,
      user.id,
      body.newRecipientEmail,
    );
  }
}
