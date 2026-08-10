import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InventoryPinConfigService, SaveConfigDto } from '../application/inventory.pin.config.service';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';

@ApiTags('products')
@ApiBearerAuth()
@UseGuards(AuthUserSuperAndOperationAdminGuard)
@Controller('products')
export class InventoryPinConfigController {
  constructor(
    private readonly configService: InventoryPinConfigService,
  ) {}

  @Get(':id/inventory-coupon-config')
  @ApiOperation({ summary: '상품별 재고형 쿠폰 설정 조회' })
  async getConfig(@Param('id') productId: number) {
    return this.configService.findByProductId(productId);
  }

  @Put(':id/inventory-coupon-config')
  @ApiOperation({ summary: '상품별 재고형 쿠폰 설정 저장' })
  async saveConfig(
    @Param('id') productId: number,
    @Body() dto: SaveConfigDto,
  ) {
    return this.configService.save(productId, dto);
  }
}
