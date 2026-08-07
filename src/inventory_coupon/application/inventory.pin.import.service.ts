import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { InventoryPinImportBatchEntity } from '../../entity/inventory.pin.import.batch.entity';
import { InventoryPinImportErrorEntity } from '../../entity/inventory.pin.import.error.entity';
import { InventoryPinItemEntity } from '../../entity/inventory.pin.item.entity';
import { InventoryCouponProductConfigEntity } from '../../entity/inventory.coupon.product.config.entity';
import { InventoryPinCryptoService, EncryptionAAD } from './inventory.pin.crypto.service';
import { PIN_INVENTORY_ERROR } from '../domain/inventory.pin.error.codes';
import { ulid } from 'ulid';
import { createHash } from 'crypto';

export interface ImportRowInput {
  productCode: string;
  primaryCode: string;
  secondaryCode?: string | null;
  expiresOn?: string | null;
}

export interface ImportMetadata {
  supplierName: string;
  sourcePartnerCompanyId?: number | null;
  purchaseReference?: string | null;
  purchasedAt?: string | null;
  idempotencyKey: string;
  importedByUserId: number;
  originalFileName: string;
}

/**
 * productCode 행 검증 순수 함수.
 * 서비스 내부에서도 호출하고, 테스트에서도 직접 import하여 검증한다.
 */
export function validateProductCode(
  rowProductCode: string | null | undefined,
  targetProductId: number,
): { valid: boolean; errorType?: string } {
  if (!rowProductCode) {
    return { valid: false, errorType: 'REQUIRED' };
  }
  if (rowProductCode !== String(targetProductId)) {
    return { valid: false, errorType: 'PRODUCT_MISMATCH' };
  }
  return { valid: true };
}

/**
 * PIN 엑셀 입고 서비스. rev5 §6.
 *
 * - all-or-nothing: 파일 전체가 성공하거나 전체 반려
 * - encrypted spool, fingerprint 중복 검사
 * - lease/stale recovery, idempotency
 */
@Injectable()
export class InventoryPinImportService {
  private readonly logger = new Logger(InventoryPinImportService.name);

  constructor(
    @InjectRepository(InventoryPinImportBatchEntity)
    private readonly batchRepo: Repository<InventoryPinImportBatchEntity>,
    @InjectRepository(InventoryPinImportErrorEntity)
    private readonly errorRepo: Repository<InventoryPinImportErrorEntity>,
    @InjectRepository(InventoryPinItemEntity)
    private readonly itemRepo: Repository<InventoryPinItemEntity>,
    @InjectRepository(InventoryCouponProductConfigEntity)
    private readonly configRepo: Repository<InventoryCouponProductConfigEntity>,
    private readonly cryptoService: InventoryPinCryptoService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * PIN 입고 처리.
   * 파싱된 행 배열과 메타데이터를 받아 all-or-nothing commit.
   */
  async importPins(
    rows: ImportRowInput[],
    meta: ImportMetadata,
    productId: number,
  ): Promise<{ batchId: string; status: 'COMMITTED' | 'REJECTED'; errors: InventoryPinImportErrorEntity[] }> {
    // 파일 checksum
    const content = JSON.stringify(rows);
    const fileChecksum = createHash('sha256').update(content).digest();
    const requestHash = createHash('sha256')
      .update(fileChecksum)
      .update(meta.supplierName)
      .update(meta.purchaseReference ?? '')
      .digest();

    // 멱등성 확인
    const existingBatch = await this.batchRepo.findOne({
      where: { importedByUserId: meta.importedByUserId, idempotencyKey: meta.idempotencyKey },
    });
    if (existingBatch) {
      if (existingBatch.requestHash.equals(requestHash)) {
        const errors = await this.errorRepo.find({ where: { batchId: existingBatch.id } });
        return { batchId: existingBatch.id, status: existingBatch.status as any, errors };
      }
      throw new BadRequestException(PIN_INVENTORY_ERROR.IMPORT_IDEMPOTENCY_CONFLICT);
    }

    // config 확인
    const config = await this.configRepo.findOne({ where: { productId } });
    if (!config) throw new BadRequestException(PIN_INVENTORY_ERROR.CONFIG_REQUIRED);

    const spoolId = ulid();
    const keyVersion = this.cryptoService.getActiveKeyVersion();
    const now = new Date();

    // batch 생성
    const batch = this.batchRepo.create({
      supplierName: meta.supplierName,
      sourcePartnerCompanyId: meta.sourcePartnerCompanyId ?? null,
      purchaseReference: meta.purchaseReference ?? null,
      purchasedAt: meta.purchasedAt ?? null,
      originalFileName: meta.originalFileName,
      fileChecksum,
      idempotencyKey: meta.idempotencyKey,
      requestHash,
      spoolId,
      spoolKeyVersion: keyVersion,
      spoolExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      status: 'VALIDATING',
      ownerToken: ulid(),
      leaseUntil: new Date(now.getTime() + 10 * 60 * 1000),
      totalCount: rows.length,
      importedByUserId: meta.importedByUserId,
    });
    const savedBatch = await this.batchRepo.save(batch);

    // 검증
    const errors: InventoryPinImportErrorEntity[] = [];
    const seenPrimary = new Set<string>();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // 1-based + header

      // canonicalize
      const primaryCode = this.canonicalize(row.primaryCode);
      const secondaryCode = row.secondaryCode ? this.canonicalize(row.secondaryCode) : null;

      if (!primaryCode) {
        errors.push(this.createError(savedBatch.id, rowNum, 'primaryCode', 'REQUIRED'));
        continue;
      }

      // 행의 productCode 필수 검증
      const productCheck = validateProductCode(row.productCode, productId);
      if (!productCheck.valid) {
        errors.push(this.createError(savedBatch.id, rowNum, 'productCode', productCheck.errorType!));
        continue;
      }

      // secondary 구조 정합
      if (config.secondaryCodeLabel && !secondaryCode) {
        errors.push(this.createError(savedBatch.id, rowNum, 'secondaryCode', 'REQUIRED_BY_SCHEMA'));
        continue;
      }
      if (!config.secondaryCodeLabel && secondaryCode) {
        errors.push(this.createError(savedBatch.id, rowNum, 'secondaryCode', 'NOT_ALLOWED_BY_SCHEMA'));
        continue;
      }

      // 파일 내부 중복
      const key = `${productId}:${primaryCode}`;
      if (seenPrimary.has(key)) {
        errors.push(this.createError(savedBatch.id, rowNum, 'primaryCode', 'DUPLICATE_IN_FILE', this.cryptoService.mask(primaryCode)));
        continue;
      }
      seenPrimary.add(key);

      // DB 기존 중복
      const fp = this.cryptoService.primaryFingerprint(productId, primaryCode);
      const existingItem = await this.itemRepo.findOne({
        where: { productId, primaryCodeFingerprint: fp },
      });
      if (existingItem) {
        errors.push(this.createError(savedBatch.id, rowNum, 'primaryCode', 'DUPLICATE_IN_DB', this.cryptoService.mask(primaryCode)));
        continue;
      }
    }

    // 검증 오류 → REJECTED
    if (errors.length > 0) {
      await this.errorRepo.save(errors);
      savedBatch.status = 'REJECTED';
      savedBatch.rejectedCount = errors.length;
      await this.batchRepo.save(savedBatch);
      return { batchId: savedBatch.id, status: 'REJECTED', errors };
    }

    // 트랜잭션으로 item 전체 INSERT
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // config FOR SHARE 재검증
      const [configRow] = await queryRunner.query(
        'SELECT * FROM `inventory_coupon_product_config` WHERE `product_id` = ? FOR SHARE',
        [productId],
      );
      if (!configRow || configRow.version !== config.version) {
        // config 변경됨 → 재검증 필요
        await queryRunner.rollbackTransaction();
        throw new BadRequestException('상품 설정이 변경되었습니다. 다시 시도하세요.');
      }

      const items: InventoryPinItemEntity[] = [];
      for (const row of rows) {
        const primaryCode = this.canonicalize(row.primaryCode);
        const secondaryCode = row.secondaryCode ? this.canonicalize(row.secondaryCode) : null;
        const cryptoContextId = ulid();

        const primaryAAD: EncryptionAAD = {
          cryptoContextId,
          productId,
          codeSchemaVersion: config.codeSchemaVersion,
          fieldRole: 'PRIMARY',
        };
        const primaryCiphertext = this.cryptoService.encrypt(primaryCode, primaryAAD);

        let secondaryCiphertext: string | null = null;
        if (secondaryCode) {
          const secondaryAAD: EncryptionAAD = {
            cryptoContextId,
            productId,
            codeSchemaVersion: config.codeSchemaVersion,
            fieldRole: 'SECONDARY',
          };
          secondaryCiphertext = this.cryptoService.encrypt(secondaryCode, secondaryAAD);
        }

        const item = queryRunner.manager.create(InventoryPinItemEntity, {
          cryptoContextId,
          importBatchId: savedBatch.id,
          productId,
          codeSchemaVersion: config.codeSchemaVersion,
          primaryCodeCiphertext: primaryCiphertext,
          secondaryCodeCiphertext: secondaryCiphertext,
          cryptoKeyVersion: this.cryptoService.getActiveKeyVersion(),
          primaryCodeFingerprint: this.cryptoService.primaryFingerprint(productId, primaryCode),
          pairFingerprint: this.cryptoService.pairFingerprint(productId, primaryCode, secondaryCode),
          primaryCodeMasked: this.cryptoService.mask(primaryCode),
          secondaryCodeMasked: secondaryCode ? this.cryptoService.mask(secondaryCode) : null,
          status: 'AVAILABLE',
          expiresOn: row.expiresOn ?? null,
        });
        items.push(item);
      }

      await queryRunner.manager.save(items);

      // batch COMMITTED
      await queryRunner.query(
        `UPDATE \`inventory_pin_import_batch\`
         SET \`status\` = 'COMMITTED', \`committed_count\` = ?, \`committed_at\` = NOW(6)
         WHERE \`id\` = ?`,
        [items.length, savedBatch.id],
      );

      await queryRunner.commitTransaction();
      return { batchId: savedBatch.id, status: 'COMMITTED', errors: [] };
    } catch (err: any) {
      await queryRunner.rollbackTransaction();

      if (err?.code === 'ER_DUP_ENTRY') {
        // UNIQUE 충돌 → batch REJECTED
        savedBatch.status = 'REJECTED';
        await this.batchRepo.save(savedBatch);
        throw new BadRequestException(PIN_INVENTORY_ERROR.DUPLICATE);
      }
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  private canonicalize(value: string): string {
    // UTF-8 BOM과 앞뒤 공백만 제거
    return value.replace(/^\uFEFF/, '').trim();
  }

  private createError(
    batchId: string,
    rowNumber: number,
    field: string,
    errorCode: string,
    maskedIdentifier?: string,
  ): InventoryPinImportErrorEntity {
    return this.errorRepo.create({
      batchId,
      rowNumber,
      field,
      errorCode,
      maskedIdentifier: maskedIdentifier ?? null,
    });
  }
}
