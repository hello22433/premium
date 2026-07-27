import 'reflect-metadata';
import * as dotenv from 'dotenv';
import * as mysql from 'mysql2/promise';
import * as path from 'path';
import { DataSource, IsNull, Not, Repository } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';

import { OrderEntity } from '../../entity/order.entity';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { IOrderStatus } from '../../order/interface/order.status';
import { IOrderType } from '../../order/interface/order.type';
import { IOrderSendMethod } from '../../order/interface/order.send.method';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';

dotenv.config();

jest.setTimeout(120_000);

const TEST_DB_NAME_PATTERN = /test/i;
const database = process.env.DATABASE_DATABASE;
const describeDb = database && TEST_DB_NAME_PATTERN.test(database) ? describe : describe.skip;

/**
 * D3-55 finding 3 — reconcile trId 복구 쿼리 실 SQL 검증.
 *
 * getOrderStatusByExternalOrderId 의 trId 복구는
 *   findOne({ where: { orderProductMapping: { order: { id } }, externalTrId: Not(IsNull()) }, select: ['externalTrId'] })
 * 로, "연관 관계 필터(orderProductMapping.order.id) + 컬럼 부분 select" 조합이다.
 * 유닛 스펙은 findOne 을 mock 하므로 이 조합이 실제로 올바른 JOIN SQL 을 만들어 root 를 집는지는
 * 검증되지 않는다. 본 테스트는 재발행(root=trId 보유 / tip=trId=null) 데이터를 실 DB 에 심고,
 * 복구 쿼리가 root 의 trId 를, tip 조회(id DESC)가 tip 을 정확히 반환하는지 확인한다.
 */
describeDb('D3-55 reconcile trId 복구 쿼리 DB integration', () => {
  let dataSource: DataSource;
  let orderRepo: Repository<OrderEntity>;
  let mappingRepo: Repository<OrderProductMappingEntity>;
  let deliveryRepo: Repository<OrderDeliveryEntity>;

  beforeAll(async () => {
    initializeTransactionalContext();
    deleteDataSourceByName('default');

    const connection = await mysql.createConnection({
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT),
      user: process.env.DATABASE_USERNAME,
      password: process.env.DATABASE_PASSWORD,
      multipleStatements: false,
    });
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await connection.end();

    dataSource = new DataSource({
      type: 'mysql',
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT),
      username: process.env.DATABASE_USERNAME,
      password: process.env.DATABASE_PASSWORD,
      database: database!,
      entities: [path.join(process.cwd(), 'src/**/*.entity.ts')],
      namingStrategy: new SnakeNamingStrategy(),
      timezone: '+09:00',
      synchronize: true,
      dropSchema: true,
      logging: false,
      extra: { connectionLimit: 5 },
    });

    await dataSource.initialize();
    addTransactionalDataSource(dataSource);

    orderRepo = dataSource.getRepository(OrderEntity);
    mappingRepo = dataSource.getRepository(OrderProductMappingEntity);
    deliveryRepo = dataSource.getRepository(OrderDeliveryEntity);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    deleteDataSourceByName('default');
  });

  it('externalTrId IS NOT NULL 복구 쿼리는 재발행 tip 이 아니라 root 의 trId 를 반환한다', async () => {
    // 외부주문 1건: order → mapping → (root: trId 보유 / tip: trId=null, replacedFromId=root)
    const order = await orderRepo.save(
      orderRepo.create({
        userId: 1,
        code: 'D355-RECON-1',
        status: IOrderStatus.DELIVERY_COMPLETE,
        type: IOrderType.GENERAL,
        eventName: 'd355-recon',
        registerAt: new Date(),
        apiAppId: '1',
        externalOrderId: 'EXT-D355-1',
      }),
    );
    const mapping = await mappingRepo.save(
      mappingRepo.create({
        orderId: order.id,
        productId: 1,
        amount: 1,
        topImagePath: '',
        midImagePath: '',
      }),
    );
    const root = await deliveryRepo.save(
      deliveryRepo.create({
        orderProductMappingId: mapping.id,
        status: IOrderDeliveryStatus.CANCEL,
        deliveryMethod: IOrderSendMethod.MMS,
        deliveryTarget: 'enc',
        sendRequestAt: new Date(),
        externalTrId: 'TR-D355-1',
        couponStatus: OrderDeliveryCouponStatus.CANCEL,
        discardedAt: new Date(),
        actualSendAt: new Date(),
      }),
    );
    const tip = await deliveryRepo.save(
      deliveryRepo.create({
        orderProductMappingId: mapping.id,
        status: IOrderDeliveryStatus.WAIT,
        deliveryMethod: IOrderSendMethod.MMS,
        deliveryTarget: 'enc',
        sendRequestAt: new Date(),
        externalTrId: null,
        replacedFromId: root.id,
        couponStatus: OrderDeliveryCouponStatus.NOT_USED,
        actualSendAt: new Date(),
      }),
    );

    // (1) trId 복구 쿼리: 연관필터 + 부분 select + IS NOT NULL → root 의 trId
    const recovered = await deliveryRepo.findOne({
      where: { orderProductMapping: { order: { id: order.id } }, externalTrId: Not(IsNull()) },
      select: ['externalTrId'],
    });
    expect(recovered?.externalTrId).toBe('TR-D355-1');

    // (2) 상태 조회용 tip 선택(id DESC) → 가장 최신 delivery = tip
    const latest = await deliveryRepo.findOne({
      where: { orderProductMapping: { order: { id: order.id } } },
      order: { id: 'DESC' },
    });
    expect(latest?.id).toBe(tip.id);
    expect(latest?.externalTrId).toBeNull();
  });
});
