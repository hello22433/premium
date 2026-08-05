import 'reflect-metadata';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { OrderEntity } from '../../entity/order.entity';

describe('OrderService document guard query SQL', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'mysql',
      host: 'localhost',
      database: 'sql-build-only',
      entities: [path.join(process.cwd(), 'src/**/*.entity.ts')],
      namingStrategy: new SnakeNamingStrategy(),
    });

    await (dataSource as any).buildMetadatas();
  }, 60_000);

  const buildDestructionCertificateGuardSql = () =>
    dataSource
      .getRepository(OrderEntity)
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .withDeleted()
      .where('order.id = :id', { id: 1 })
      .andWhere('order.deletedAt IS NULL')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .getSql();

  it('삭제 주문은 직접 제외하면서 soft-delete 배송건은 파기확인서 게이트 조인에 포함한다', () => {
    const sql = buildDestructionCertificateGuardSql();

    expect(sql).toContain('`order`.`deleted_at` IS NULL');
    expect(sql).toContain('LEFT JOIN `order_delivery` `orderDeliveries`');
    expect(sql).not.toContain('`orderDeliveries`.`deleted_at` IS NULL');
  });
});
