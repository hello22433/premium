import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { PopularProductEntity } from '../../entity/popular.product.entity';
import { ProductEntity } from '../../entity/product.entity';
import { PopularProductGetListResDto } from '../api/popular.product.res.dto';

interface PopularProductRaw {
  product_id: number;
  unique_company_count: number;
  total_quantity: number;
}

@Injectable()
export class PopularProductService {
  private logger = new Logger('PopularProductService');

  constructor(
    @InjectRepository(PopularProductEntity)
    private popularProductRepository: Repository<PopularProductEntity>,
    @InjectRepository(ProductEntity)
    private productRepository: Repository<ProductEntity>,
    private dataSource: DataSource,
  ) {}

  async getList(): Promise<PopularProductGetListResDto> {
    const popularProducts = await this.popularProductRepository.find({
      relations: ['product', 'product.brand'],
      order: { rank: 'ASC' },
    });

    return {
      list: popularProducts.map((pp) => ({
        rank: pp.rank,
        productId: pp.productId,
        productName: pp.product?.name ?? '',
        brandName: pp.product?.brand?.nameKorean ?? '',
        imagePath: pp.product?.imagePath ?? '',
        uniqueCompanyCount: pp.uniqueCompanyCount,
        totalQuantity: pp.totalQuantity,
        calculatedAt: pp.calculatedAt,
      })),
    };
  }

  async calculateAndSave(): Promise<void> {
    const query = `
      SELECT
        opm.product_id,
        COUNT(DISTINCT u.company_id) as unique_company_count,
        COUNT(od.id) as total_quantity
      FROM order_delivery od
      JOIN order_product_mapping opm ON od.order_product_mapping_id = opm.id
      JOIN \`order\` o ON opm.order_id = o.id
      JOIN user u ON o.user_id = u.id
      WHERE o.type != 'SSG'
        AND od.actual_send_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        AND od.status = 'COMPLETE'
      GROUP BY opm.product_id
      ORDER BY unique_company_count DESC, total_quantity DESC
      LIMIT 4
    `;

    const results: PopularProductRaw[] = await this.dataSource.query(query);

    if (results.length === 0) {
      this.logger.log('No popular products found for the last 7 days');
      return;
    }

    const now = new Date();

    await this.dataSource.transaction(async (manager) => {
      await manager.delete(PopularProductEntity, {});

      const entities = results.map((row, index) => {
        const entity = new PopularProductEntity();
        entity.productId = row.product_id;
        entity.uniqueCompanyCount = Number(row.unique_company_count);
        entity.totalQuantity = Number(row.total_quantity);
        entity.rank = index + 1;
        entity.calculatedAt = now;
        return entity;
      });

      await manager.save(PopularProductEntity, entities);
    });

    this.logger.log(`Popular products updated: ${results.length} items`);
  }
}