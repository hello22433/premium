import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InventoryPinImportService, ImportRowInput, ImportMetadata } from '../application/inventory.pin.import.service';
import { InventoryPinStockService } from '../application/inventory.pin.stock.service';
import { InventoryPinConfigService } from '../application/inventory.pin.config.service';
import { InventoryPinPolicyService } from '../application/inventory.pin.policy.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InventoryPinItemEntity } from '../../entity/inventory.pin.item.entity';
import { InventoryPinImportBatchEntity } from '../../entity/inventory.pin.import.batch.entity';
import { PIN_INVENTORY_ERROR } from '../domain/inventory.pin.error.codes';
import { BadRequestException } from '@nestjs/common';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';

@ApiTags('inventory-coupons')
@ApiBearerAuth()
@UseGuards(AuthUserSuperAndOperationAdminGuard)
@Controller('inventory-coupons')
export class InventoryPinAdminController {
  constructor(
    private readonly importService: InventoryPinImportService,
    private readonly stockService: InventoryPinStockService,
    private readonly configService: InventoryPinConfigService,
    private readonly policyService: InventoryPinPolicyService,
    @InjectRepository(InventoryPinItemEntity)
    private readonly itemRepo: Repository<InventoryPinItemEntity>,
    @InjectRepository(InventoryPinImportBatchEntity)
    private readonly batchRepo: Repository<InventoryPinImportBatchEntity>,
  ) {}

  @Get('stock')
  @ApiOperation({ summary: '상품별 재고 현황' })
  async getStock(@Query('productId') productId: number) {
    const config = await this.configService.getByProductIdOrFail(productId);
    return this.stockService.getStockByProduct(productId, config.lowStockThreshold);
  }

  @Get('imports')
  @ApiOperation({ summary: '입고 배치 목록' })
  async listImports(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    const [items, total] = await this.batchRepo.findAndCount({
      order: { id: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total, page, limit };
  }

  @Get('imports/:id')
  @ApiOperation({ summary: '입고 배치 상세' })
  async getImport(@Param('id') id: string) {
    return this.batchRepo.findOneOrFail({ where: { id } });
  }

  @Post('imports')
  @ApiOperation({ summary: 'PIN 엑셀 입고' })
  async importPins(@Body() body: {
    productId: number;
    rows: ImportRowInput[];
    meta: ImportMetadata;
  }) {
    return this.importService.importPins(body.rows, body.meta, body.productId);
  }

  @Post('pins')
  @ApiOperation({ summary: 'PIN 수동 등록 (단건)' })
  async manualRegister(@Body() body: {
    productId: number;
    primaryCode: string;
    secondaryCode?: string | null;
    expiresOn?: string | null;
    meta: ImportMetadata;
  }) {
    const row: ImportRowInput = {
      productCode: String(body.productId),
      primaryCode: body.primaryCode,
      secondaryCode: body.secondaryCode,
      expiresOn: body.expiresOn,
    };
    return this.importService.importPins([row], body.meta, body.productId);
  }

  @Get('pins')
  @ApiOperation({ summary: 'PIN 목록 (마스킹)' })
  async listPins(
    @Query('productId') productId?: number,
    @Query('status') status?: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    const qb = this.itemRepo.createQueryBuilder('item')
      .select([
        'item.id',
        'item.productId',
        'item.codeSchemaVersion',
        'item.primaryCodeMasked',
        'item.secondaryCodeMasked',
        'item.status',
        'item.assignedOrderDeliveryId',
        'item.assignedAt',
        'item.expiresOn',
        'item.voidedAt',
        'item.voidReason',
        'item.createdAt',
      ])
      .where('item.deletedAt IS NULL')
      .orderBy('item.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (productId) qb.andWhere('item.productId = :productId', { productId });
    if (status) qb.andWhere('item.status = :status', { status });

    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, limit };
  }

  @Patch('pins/:id/void')
  @ApiOperation({ summary: 'AVAILABLE PIN 일반 폐기 (§6.7)' })
  async voidPin(
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    // AVAILABLE이면서 미할당인 item만 조건부 UPDATE
    const result = await this.itemRepo
      .createQueryBuilder()
      .update(InventoryPinItemEntity)
      .set({
        status: 'VOID',
        voidedAt: new Date(),
        voidReason: body.reason,
      })
      .where('id = :id AND status = :status AND assigned_order_delivery_id IS NULL', {
        id,
        status: 'AVAILABLE',
      })
      .execute();

    if (result.affected !== 1) {
      throw new BadRequestException(PIN_INVENTORY_ERROR.VOID_STATE_CONFLICT);
    }
    return { success: true };
  }
}
