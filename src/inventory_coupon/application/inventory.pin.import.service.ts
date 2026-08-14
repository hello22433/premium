import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { InventoryPinImportBatchEntity } from '../../entity/inventory.pin.import.batch.entity';
import { InventoryPinImportErrorEntity } from '../../entity/inventory.pin.import.error.entity';
import { InventoryPinItemEntity } from '../../entity/inventory.pin.item.entity';
import { InventoryCouponProductConfigEntity } from '../../entity/inventory.coupon.product.config.entity';
import { InventoryPinCryptoService, EncryptionAAD } from './inventory.pin.crypto.service';
import { PIN_INVENTORY_ERROR } from '../domain/inventory.pin.error.codes';
import { INVALID_EXPIRES_ON, normalizeExpiresOn, todayInKst } from '../domain/inventory.pin.expires';
import { ulid } from 'ulid';
import { createHash } from 'crypto';

export interface ImportRowInput {
  /**
   * 엑셀 실제 행 번호. 반려 사유를 운영자가 파일에서 바로 찾을 수 있어야 하므로
   * 빈 행을 건너뛴 파서가 원본 행 번호를 그대로 넘긴다. 없으면 배열 순서로 계산한다.
   */
  rowNumber?: number;
  /**
   * 상품 식별 열. 확정 양식(코드/유효기간)에는 없으므로 **선택**이다.
   * 공급사 파일에 들어 있으면 오업로드 방지용으로 대상 상품과 대조한다.
   */
  productCode?: string | null;
  primaryCode: string;
  secondaryCode?: string | null;
  expiresOn?: string | null;
}

/** 파싱 단계에서 확정된 행 오류. 배치 반려 사유로 그대로 저장한다. */
export interface ImportRowError {
  rowNumber: number;
  field: string;
  errorCode: string;
}

export interface ImportMetadata {
  supplierName: string;
  sourcePartnerCompanyId?: number | null;
  purchaseReference?: string | null;
  purchasedAt?: string | null;
  idempotencyKey: string;
  importedByUserId: number;
  originalFileName: string;
  /**
   * 업로드 원본 바이트의 SHA-256. 엑셀 업로드는 같은 파일이면 같은 값이어야 하므로
   * 파싱 결과가 아니라 파일 자체로 계산해 넘긴다. 수동 등록은 생략한다(행 기준 계산).
   */
  fileChecksum?: Buffer;
}

/**
 * 멱등 재요청 판정에 쓰는 canonical 입력.
 *
 * 확정 양식에는 파일 안에 상품 정보가 없다. productId 를 빼면 **같은 파일을 다른 상품에**
 * 올렸을 때 충돌로 막히지 않고 첫 번째 배치 결과가 그대로 돌아온다(입고된 것으로 착각).
 * 배치 결과에 영향을 주는 메타를 모두 넣고, 길이 안전하게 JSON 으로 직렬화한다(null/빈문자열 구분).
 */
export function canonicalRequest(
  meta: Pick<ImportMetadata, 'supplierName' | 'sourcePartnerCompanyId' | 'purchaseReference' | 'purchasedAt'>,
  productId: number,
): string {
  return JSON.stringify([
    'v1',
    productId,
    meta.supplierName,
    meta.sourcePartnerCompanyId ?? null,
    meta.purchaseReference ?? null,
    meta.purchasedAt ?? null,
  ]);
}

/**
 * productCode 행 검증 순수 함수.
 *
 * 확정 양식에는 상품 열이 없고 대상 상품은 업로드 화면에서 고른다. 따라서 값이 없으면 통과다.
 * 값이 있으면 다른 상품 파일을 잘못 올린 것이므로 반드시 대조해서 막는다.
 */
export function validateProductCode(
  rowProductCode: string | null | undefined,
  targetProductId: number,
): { valid: boolean; errorType?: string } {
  if (!rowProductCode) {
    return { valid: true };
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
    parseErrors: ImportRowError[] = [],
  ): Promise<{ batchId: string; status: 'COMMITTED' | 'REJECTED'; errors: InventoryPinImportErrorEntity[] }> {
    // 파일 checksum. 엑셀 업로드는 원본 바이트 해시를 쓰고, 수동 등록은 행 내용으로 계산한다.
    const fileChecksum = meta.fileChecksum ?? createHash('sha256').update(JSON.stringify(rows)).digest();
    const requestHash = createHash('sha256').update(fileChecksum).update(canonicalRequest(meta, productId)).digest();

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
      totalCount: rows.length + parseErrors.length,
      importedByUserId: meta.importedByUserId,
    });
    const savedBatch = await this.batchRepo.save(batch);

    // 검증
    const errors: InventoryPinImportErrorEntity[] = parseErrors.map((e) =>
      this.createError(savedBatch.id, e.rowNumber, e.field, e.errorCode),
    );
    const seenPrimary = new Set<string>();
    // 정규화된 유효기간. INSERT 단계가 원본 문자열을 다시 쓰면 검증과 저장값이 갈라진다.
    const normalizedExpiresOn = new Map<number, string | null>();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = row.rowNumber ?? i + 2; // 1-based + header

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

      // 유효기간은 엑셀·수동 등록 양쪽 모두 여기서 정규화한다.
      // 수동 API 는 `2026-8-1` 같은 값을 보낼 수 있어 문자열 비교만으로는 만료 판정이 깨진다.
      const expiresOn = normalizeExpiresOn(row.expiresOn);
      if (expiresOn === INVALID_EXPIRES_ON) {
        errors.push(this.createError(savedBatch.id, rowNum, 'expiresOn', 'INVALID_FORMAT'));
        continue;
      }

      // 이미 지난 유효기간은 할당 대상이 될 수 없다. 재고로 쌓지 않고 입고 시점에 되돌린다.
      if (expiresOn && expiresOn < todayInKst()) {
        errors.push(this.createError(savedBatch.id, rowNum, 'expiresOn', 'EXPIRED'));
        continue;
      }
      normalizedExpiresOn.set(i, expiresOn);

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
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
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
          expiresOn: normalizedExpiresOn.get(i) ?? null,
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
