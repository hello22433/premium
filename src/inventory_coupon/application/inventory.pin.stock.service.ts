import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InventoryPinItemEntity } from '../../entity/inventory.pin.item.entity';

export interface StockSummary {
  productId: number;
  totalImported: number;
  available: number;
  availableExpired: number;
  assigned: number;
  sentCount: number;
  failedCount: number;
  unknownCount: number;
  voidCount: number;
  lowStockThreshold: number;
  isLowStock: boolean;
}

/**
 * 재고 현황 조회 서비스. rev5 §6.5.
 */
@Injectable()
export class InventoryPinStockService {
  constructor(
    @InjectRepository(InventoryPinItemEntity)
    private readonly itemRepo: Repository<InventoryPinItemEntity>,
  ) {}

  async getStockByProduct(productId: number, lowStockThreshold: number): Promise<StockSummary> {
    // KST 기준 오늘 날짜 사용
    const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const today = kstNow.toISOString().slice(0, 10);

    const result = await this.itemRepo
      .createQueryBuilder('item')
      .select([
        'COUNT(*) as total',
        `SUM(CASE WHEN item.status = 'AVAILABLE' AND (item.expiresOn IS NULL OR item.expiresOn >= :today) THEN 1 ELSE 0 END) as available`,
        `SUM(CASE WHEN item.status = 'AVAILABLE' AND item.expiresOn IS NOT NULL AND item.expiresOn < :today THEN 1 ELSE 0 END) as availableExpired`,
        `SUM(CASE WHEN item.status = 'ASSIGNED' THEN 1 ELSE 0 END) as assigned`,
        `SUM(CASE WHEN item.status = 'VOID' THEN 1 ELSE 0 END) as voidCount`,
      ])
      .where('item.productId = :productId', { productId })
      .andWhere('item.deletedAt IS NULL')
      .setParameter('today', today)
      .getRawOne();

    const available = Number(result?.available ?? 0);

    // fulfillment 집계는 order_delivery에서
    const fulfillmentResult = await this.itemRepo.manager.query(
      `SELECT
        SUM(CASE WHEN od.direct_pin_fulfillment_status = 'SENT' THEN 1 ELSE 0 END) as sentCount,
        SUM(CASE WHEN od.direct_pin_fulfillment_status = 'FAILED' THEN 1 ELSE 0 END) as failedCount,
        SUM(CASE WHEN od.direct_pin_fulfillment_status = 'UNKNOWN' THEN 1 ELSE 0 END) as unknownCount
       FROM inventory_pin_item i
       JOIN order_delivery od ON od.id = i.assigned_order_delivery_id
       WHERE i.product_id = ? AND i.status = 'ASSIGNED' AND i.deleted_at IS NULL`,
      [productId],
    );

    return {
      productId,
      totalImported: Number(result?.total ?? 0),
      available,
      availableExpired: Number(result?.availableExpired ?? 0),
      assigned: Number(result?.assigned ?? 0),
      sentCount: Number(fulfillmentResult?.[0]?.sentCount ?? 0),
      failedCount: Number(fulfillmentResult?.[0]?.failedCount ?? 0),
      unknownCount: Number(fulfillmentResult?.[0]?.unknownCount ?? 0),
      voidCount: Number(result?.voidCount ?? 0),
      lowStockThreshold,
      isLowStock: available <= lowStockThreshold,
    };
  }
}
