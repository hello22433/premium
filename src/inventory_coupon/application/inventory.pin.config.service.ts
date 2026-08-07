import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { InventoryCouponProductConfigEntity } from '../../entity/inventory.coupon.product.config.entity';
import { PIN_INVENTORY_ERROR } from '../domain/inventory.pin.error.codes';

@Injectable()
export class InventoryPinConfigService {
  constructor(
    @InjectRepository(InventoryCouponProductConfigEntity)
    private readonly configRepo: Repository<InventoryCouponProductConfigEntity>,
  ) {}

  async findByProductId(productId: number): Promise<InventoryCouponProductConfigEntity | null> {
    return this.configRepo.findOne({ where: { productId } });
  }

  async getByProductIdOrFail(productId: number): Promise<InventoryCouponProductConfigEntity> {
    const config = await this.findByProductId(productId);
    if (!config) {
      throw new NotFoundException(PIN_INVENTORY_ERROR.CONFIG_REQUIRED);
    }
    return config;
  }

  /**
   * 상품 설정 저장. rev5 §4.2.
   * config 행을 FOR UPDATE로 잠그고, 코드 구조 변경이면 codeSchemaVersion+1.
   */
  @Transactional()
  async save(
    productId: number,
    dto: SaveConfigDto,
  ): Promise<InventoryCouponProductConfigEntity> {
    // 보조 코드 라벨만 단독 존재하는 조합 금지
    if (!dto.primaryCodeLabel && dto.secondaryCodeLabel) {
      throw new BadRequestException('primaryCodeLabel 없이 secondaryCodeLabel만 존재할 수 없습니다');
    }
    if (Number(dto.faceValueAmount) <= 0) {
      throw new BadRequestException('액면가는 0 초과여야 합니다');
    }

    const existing = await this.configRepo
      .createQueryBuilder('c')
      .setLock('pessimistic_write')
      .where('c.productId = :productId', { productId })
      .getOne();

    if (!existing) {
      // 신규 생성
      const entity = this.configRepo.create({
        productId,
        ...dto,
        version: 1,
        codeSchemaVersion: 1,
      });
      return this.configRepo.save(entity);
    }

    // 코드 구조 변경 판정: secondaryCodeLabel의 NULL ↔ NOT NULL 전이
    const wasSecondary = existing.secondaryCodeLabel != null;
    const isSecondary = dto.secondaryCodeLabel != null;
    const structureChanged = wasSecondary !== isSecondary;

    existing.faceValueAmount = dto.faceValueAmount;
    existing.currencyCode = dto.currencyCode;
    existing.primaryCodeLabel = dto.primaryCodeLabel;
    existing.secondaryCodeLabel = dto.secondaryCodeLabel;
    existing.howToUse = dto.howToUse;
    existing.notice = dto.notice;
    existing.templateLocale = dto.templateLocale ?? 'en';
    existing.lowStockThreshold = dto.lowStockThreshold;
    existing.defaultFromEmail = dto.defaultFromEmail;
    existing.defaultSubject = dto.defaultSubject;
    existing.version = existing.version + 1;
    if (structureChanged) {
      existing.codeSchemaVersion = existing.codeSchemaVersion + 1;
    }
    return this.configRepo.save(existing);
  }
}

export interface SaveConfigDto {
  faceValueAmount: string;
  currencyCode: string;
  primaryCodeLabel: string;
  secondaryCodeLabel: string | null;
  howToUse: string;
  notice: string;
  templateLocale?: string;
  lowStockThreshold: number;
  defaultFromEmail: string;
  defaultSubject: string;
}
