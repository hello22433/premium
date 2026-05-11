import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { CancelWebhookAdminService } from './cancel.webhook.admin.service';
import {
  CancelWebhookLogListResDto,
  CancelWebhookLogQueryDto,
  CancelWebhookTestResDto,
  CancelWebhookViewDto,
  UpdateCancelWebhookReqDto,
} from './dto/cancel.webhook.admin.dto';

@ApiTags('user-management')
@Controller('user-management/api-keys/:accountId/cancel-webhook')
@UseGuards(AuthUserSuperAndOperationAdminGuard)
@ApiBearerAuth()
export class CancelWebhookAdminController {
  constructor(private readonly service: CancelWebhookAdminService) {}

  @Get()
  @ApiOperation({ summary: '[어드민] 폐기 통보 Webhook 설정 조회' })
  @ApiOkResponse({ type: CancelWebhookViewDto })
  get(@Param('accountId') accountId: string): Promise<CancelWebhookViewDto> {
    return this.service.get(accountId);
  }

  @Put()
  @ApiOperation({ summary: '[어드민] 폐기 통보 Webhook URL/활성화 수정' })
  @ApiOkResponse({ type: CancelWebhookViewDto })
  update(
    @Param('accountId') accountId: string,
    @Body() body: UpdateCancelWebhookReqDto,
  ): Promise<CancelWebhookViewDto> {
    return this.service.update(accountId, body);
  }

  @Delete()
  @ApiOperation({ summary: '[어드민] 폐기 통보 Webhook 해제' })
  async clear(@Param('accountId') accountId: string): Promise<{ ok: true }> {
    await this.service.clear(accountId);
    return { ok: true };
  }

  @Post('test')
  @ApiOperation({ summary: '[어드민] 폐기 통보 Webhook 테스트 발송' })
  @ApiOkResponse({ type: CancelWebhookTestResDto })
  test(@Param('accountId') accountId: string): Promise<CancelWebhookTestResDto> {
    return this.service.test(accountId);
  }

  @Get('logs')
  @ApiOperation({ summary: '[어드민] 폐기 통보 Webhook 호출 이력' })
  @ApiOkResponse({ type: CancelWebhookLogListResDto })
  listLogs(
    @Param('accountId') accountId: string,
    @Query() query: CancelWebhookLogQueryDto,
  ): Promise<CancelWebhookLogListResDto> {
    return this.service.listLogs(accountId, query);
  }
}
