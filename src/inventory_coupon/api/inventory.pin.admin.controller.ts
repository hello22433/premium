import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { createHash } from 'crypto';
import * as ExcelJS from 'exceljs';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InventoryPinImportService, ImportRowInput, ImportMetadata } from '../application/inventory.pin.import.service';
import { InventoryPinExcelParser } from '../application/inventory.pin.excel.parser';
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
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';

/**
 * 입고 실행자(importedByUserId)는 감사 기록이므로 클라이언트 주장값을 쓰지 않는다.
 * 요청 본문에서는 제외하고 컨트롤러가 로그인 사용자로 채운다.
 */
type ImportMetadataInput = Omit<ImportMetadata, 'importedByUserId'>;

@ApiTags('inventory-coupons')
@ApiBearerAuth()
@UseGuards(AuthUserSuperAndOperationAdminGuard)
@Controller('inventory-coupons')
export class InventoryPinAdminController {
  constructor(
    private readonly importService: InventoryPinImportService,
    private readonly excelParser: InventoryPinExcelParser,
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

  @Get('imports/template')
  @ApiOperation({ summary: 'PIN 입고 엑셀 양식 다운로드' })
  async downloadTemplate(@Query('productId') productId: number | undefined, @Res() res: Response) {
    // 보조코드를 쓰는 상품만 세 번째 열을 내려준다. 안 쓰는 상품은 열이 있으면 입고가 반려된다.
    const config = productId ? await this.configService.getByProductIdOrFail(productId) : null;

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('PIN');
    const header = ['코드', '유효기간'];
    const sample = ['VSREET2RJQXCA2', '2027-12-31'];
    if (config?.secondaryCodeLabel) {
      header.push('보조코드');
      sample.push('1234');
    }

    sheet.addRow(header);
    sheet.addRow(sample);
    sheet.getRow(1).font = { bold: true };
    sheet.columns.forEach((column, index) => {
      column.width = 24;
      // 코드 계열 열은 텍스트 서식으로 박아둔다. 숫자 서식이면 선행 0 과 정밀도가 조용히 사라진다.
      if (index !== 1) column.numFmt = '@';
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent('PIN_입고_양식.xlsx')}"`);
    await workbook.xlsx.write(res);
    res.end();
  }

  @Get('imports/:id')
  @ApiOperation({ summary: '입고 배치 상세' })
  async getImport(@Param('id') id: string) {
    return this.batchRepo.findOneOrFail({ where: { id } });
  }

  /**
   * PIN 엑셀 입고. 파일을 그대로 받아 **서버가 파싱한다.**
   * 프론트가 파싱하면 PIN 원본이 브라우저 메모리와 JSON 본문에 평문으로 올라온다(계약 §7.5).
   * 업로드 버퍼는 memory storage 라 디스크에 남지 않는다.
   */
  @Post('imports')
  @ApiOperation({ summary: 'PIN 엑셀 입고' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async importPins(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: {
      productId: string;
      supplierName?: string;
      sourcePartnerCompanyId?: string;
      purchaseReference?: string;
      purchasedAt?: string;
      idempotencyKey?: string;
    },
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @User() user: ILoginUserInfo,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('엑셀 파일을 첨부해주세요.');
    }

    const productId = Number(body.productId);
    if (!Number.isInteger(productId) || productId <= 0) {
      throw new BadRequestException('상품을 선택해주세요.');
    }

    const supplierName = body.supplierName?.trim();
    if (!supplierName) {
      throw new BadRequestException('구매처를 입력해주세요.');
    }

    const idempotencyKey = (body.idempotencyKey ?? idempotencyKeyHeader ?? '').trim();
    if (!idempotencyKey) {
      throw new BadRequestException('멱등키(Idempotency-Key)가 필요합니다.');
    }

    const { rows, errors } = await this.excelParser.parse(file.buffer);

    return this.importService.importPins(
      rows,
      {
        supplierName,
        sourcePartnerCompanyId: body.sourcePartnerCompanyId ? Number(body.sourcePartnerCompanyId) : null,
        purchaseReference: body.purchaseReference?.trim() || null,
        purchasedAt: body.purchasedAt?.trim() || null,
        idempotencyKey,
        importedByUserId: user.id,
        originalFileName: this.decodeFileName(file.originalname),
        fileChecksum: createHash('sha256').update(file.buffer).digest(),
      },
      productId,
      errors,
    );
  }

  /**
   * multer 가 latin1 로 넘기는 한글 파일명 복원. 원본이 이미 UTF-8 이면 그대로 둔다.
   */
  private decodeFileName(originalName: string): string {
    const decoded = Buffer.from(originalName, 'latin1').toString('utf8');
    return decoded.includes('\uFFFD') ? originalName : decoded;
  }

  @Post('pins')
  @ApiOperation({ summary: 'PIN 수동 등록 (단건)' })
  async manualRegister(
    @Body() body: {
      productId: number;
      primaryCode: string;
      secondaryCode?: string | null;
      expiresOn?: string | null;
      meta: ImportMetadataInput;
    },
    @User() user: ILoginUserInfo,
  ) {
    const row: ImportRowInput = {
      primaryCode: body.primaryCode,
      secondaryCode: body.secondaryCode,
      expiresOn: body.expiresOn,
    };
    return this.importService.importPins(
      [row],
      { ...body.meta, importedByUserId: user.id },
      body.productId,
    );
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
