import { Controller, Get, Param, Req, UseGuards, UseFilters } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InventoryPinExternalService } from '../application/inventory.pin.external.service';
import { PinInventoryOrderResponseDto } from '../interface/inventory.pin.external.dto';
import { ApiKeyGuard } from '../../external_api/api/external.api.key.guard';
import { ExternalApiExceptionFilter } from '../../external_api/api/external.api.exception.filter';

/**
 * apiContext에서 apiAppId를 추출하는 순수 함수.
 * Guard가 apiContext를 설정해야 정상 동작한다.
 */
export function extractApiAppId(req: any): string | null {
  const apiAppId = String(req.apiContext?.apiApp?.id);
  if (!apiAppId || apiAppId === 'undefined') {
    return null;
  }
  return apiAppId;
}

@ApiTags('external-api/pin-inventory')
@ApiSecurity('api-key')
@Controller('external-api/v1/pin-inventory')
@UseGuards(ApiKeyGuard)
@UseFilters(ExternalApiExceptionFilter)
export class InventoryPinExternalController {
  constructor(
    private readonly externalService: InventoryPinExternalService,
  ) {}

  @Get('orders/:trId')
  @ApiOperation({ summary: '재고형 쿠폰 외부 API 주문 상태 조회' })
  async getOrderStatus(
    @Param('trId') trId: string,
    @Req() req: any,
  ): Promise<PinInventoryOrderResponseDto> {
    const apiAppId = extractApiAppId(req);
    if (!apiAppId) {
      throw new Error('ApiKeyGuard must resolve apiContext.apiApp');
    }
    return this.externalService.getOrderStatus(apiAppId, trId);
  }
}
