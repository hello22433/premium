import 'reflect-metadata';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as mysql from 'mysql2/promise';
import { DataSource, In, Not, Repository } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';

import { UserEntity } from '../../entity/user.entity';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { BrandEntity } from '../../entity/brand.entity';
import { ProductEntity } from '../../entity/product.entity';
import { OrderEntity } from '../../entity/order.entity';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { TestOrderDeliveryEntity } from '../../entity/test.order.delivery.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderManualEntryEntity } from '../../entity/order.manual.entry.entity';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { OrderService } from './order.service';

dotenv.config();
jest.setTimeout(120_000);

const TEST_DB_NAME_PATTERN = /test/i;

/**
 * updateTemp 의 setLock('pessimistic_write') 이 실제로 행 잠금을 거는지 실DB로 검증한다.
 *
 * 단위 테스트는 setLock 호출 여부만 확인할 수 있어, 잠금이 실제로 동시 UPDATE 를 막는지는
 * 검증되지 않는다. 여기서는 MySQL InnoDB 에서 다음을 확인한다.
 *
 *  1. SELECT ... FOR UPDATE 가 생성되는지 (쿼리 SQL 확인)
 *  2. 잠금이 실제로 동시 UPDATE 를 블로킹하는지 (testDelivery 의 한도 선점 +1 이 대기)
 *  3. 잠금 없이는 증가분이 유실되는지 (대조군 — 잠금의 필요성 입증)
 */
describe('updateTemp 매핑 행 잠금 (pessimistic_write) 실DB 검증', () => {
  let dataSource: DataSource;
  let mappingRepository: Repository<OrderProductMappingEntity>;
  let orderId: number;
  let productId: number;
  let userId: number;

  beforeAll(async () => {
    initializeTransactionalContext();
    deleteDataSourceByName('default');

    const database = process.env.DATABASE_DATABASE;
    if (!database || !TEST_DB_NAME_PATTERN.test(database)) {
      throw new Error('DB 통합테스트는 이름에 test가 포함된 DATABASE_DATABASE에서만 실행할 수 있습니다.');
    }

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
      database,
      entities: [path.join(process.cwd(), 'src/**/*.entity.ts')],
      namingStrategy: new SnakeNamingStrategy(),
      timezone: '+09:00',
      synchronize: true,
      dropSchema: true,
      logging: false,
      extra: { connectionLimit: 10 },
    });

    await dataSource.initialize();
    addTransactionalDataSource(dataSource);

    mappingRepository = dataSource.getRepository(OrderProductMappingEntity);

    const suffix = Date.now();
    const customer = await dataSource.getRepository(UserEntity).save(
      dataSource.getRepository(UserEntity).create({
        companyId: null,
        settlementCode: '',
        email: `lock-${suffix}@example.com`,
        password: 'password',
        isPasswordReset: false,
        lastActivityAt: new Date(),
        authority: 'CORPORATE_ADMIN',
        status: 'USED',
        personName: 'cust',
        personPhoneNumber: '01000000000',
        personEmail: `lock-${suffix}@example.com`,
        personCode: `lock-${suffix}`,
        corporateNumber: '',
        isHeadPerson: false,
        settleCondition: 'POST_PAYMENT',
        settleMethod: 'CASH',
        bankName: '',
        bankNumber: '',
        cardName: '',
        cardNumber: '',
        balance: 0,
        allSettleAmount: 0,
        serviceAmount: 0,
        duplicatePhoneLimit: 0,
      } as any) as unknown as UserEntity,
    );
    const pc = await dataSource.getRepository(PartnerCompanyEntity).save(
      dataSource.getRepository(PartnerCompanyEntity).create({
        code: `pc-${suffix}`,
        businessNumber: `biz-${suffix}`,
        businessName: '테스트 협력사',
        businessAddress: '서울',
        businessPhoneNumber: '0212345678',
        personName: '담당자',
        personPhoneNumber: '01000000000',
        personEmail: 'partner@example.com',
        settleCondition: 'POST_PAYMENT',
        settleDay: 1,
        settleMethod: 'CASH',
        maximumLimit: 1_000_000,
        bankName: '은행',
        bankNumber: '0000',
        status: 'ACTIVE',
      } as any) as unknown as PartnerCompanyEntity,
    );
    const brand = await dataSource.getRepository(BrandEntity).save(
      dataSource.getRepository(BrandEntity).create({
        code: `brand-${suffix}`,
        nameKorean: '테스트 브랜드',
        nameEnglish: 'Test Brand',
        isUsed: true,
      } as any) as unknown as BrandEntity,
    );
    const product = await dataSource.getRepository(ProductEntity).save(
      dataSource.getRepository(ProductEntity).create({
        code: `product-${suffix}`,
        partnerCompanyId: pc.id,
        brandId: brand.id,
        name: '테스트 상품',
        price: 10_000,
        expireDay: 30,
        category: 'A',
        settleMethod: 'PER_PRODUCT',
        settlePercent: 0,
        imagePath: '',
        type: 'GENERAL',
        couponMethod: 'NONE',
        useStatus: 'USE',
        isCancelable: true,
      } as any) as unknown as ProductEntity,
    );
    productId = product.id;
    userId = customer.id;

    const order = await dataSource.getRepository(OrderEntity).save(
      dataSource.getRepository(OrderEntity).create({
        userId: customer.id,
        code: `order-lock-${suffix}`,
        status: 'TEMP',
        type: 'GENERAL',
        eventName: '테스트 이벤트',
        registerAt: new Date(),
        sendAmount: 10_000,
        settleAmount: 0,
        isSettleBalance: false,
        isNewBillingFlow: true,
        cardSurchargeApplied: false,
        isCreditExcess: false,
      } as any) as unknown as OrderEntity,
    );
    orderId = order.id;
  });

  afterAll(async () => {
    deleteDataSourceByName('default');
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  /** updateTemp 가 쓰는 것과 동일한 매핑 1건을 만든다. */
  const seedMapping = async (testDeliveryCount: number) => {
    const mapping = await mappingRepository.save(
      mappingRepository.create({
        orderId,
        productId,
        amount: 1,
        topImagePath: '',
        midImagePath: '',
        sendMethod: 'MMS',
        fromPhoneNumber: '0212345678',
        sendTitle: '테스트 제목',
        sendContent: '테스트 내용',
        sendRequestAt: new Date(),
        testDeliveryCount,
      } as any) as unknown as OrderProductMappingEntity,
    );
    return mapping.id;
  };

  /**
   * 실DB 저장소를 물린 OrderService. updateTemp 를 실제로 호출해 검증한다.
   * 외부 I/O(금칙어·발신수단 검증, SSG)만 스텁하고 나머지는 실제 구현을 쓴다.
   */
  const buildService = () => {
    const service = Object.create(OrderService.prototype) as any;
    service.orderRepository = dataSource.getRepository(OrderEntity);
    service.orderProductMappingRepository = mappingRepository;
    service.orderDeliveryRepository = dataSource.getRepository(OrderDeliveryEntity);
    service.orderManualEntryRepository = dataSource.getRepository(OrderManualEntryEntity);
    service.testOrderDeliveryRepository = dataSource.getRepository(TestOrderDeliveryEntity);
    service.productRepository = dataSource.getRepository(ProductEntity);
    service.assertPositiveIntegerAmounts = jest.fn();
    service.assertNoForbiddenWord = jest.fn();
    service.validateSendMethods = jest.fn();
    service.buildManualEntries = jest.fn(() => []);
    service.ssgEventService = {};
    service.cryptoCipher = { encryptDeliveryTarget: jest.fn((target: string) => target) };
    service.logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
    return service;
  };

  const updateTempBody = (lines: { id?: number; productId: number }[]) => ({
    id: orderId,
    eventName: '테스트 이벤트',
    topImagePath: null,
    midImagePath: null,
    orderProductList: lines.map((line) => ({
      ...line,
      amount: 1,
      sendType: 'IMMEDIATE',
      sendMethod: 'MMS',
      orderDeliveryList: [{ deliveryTarget: '01012345678' }],
    })),
  });

  const owner = () => ({ id: userId, email: 'lock@example.com', authority: 'CORPORATE_ADMIN' }) as any;

  // 리뷰 지적: 기존 케이스들이 손으로 재작성한 동등 쿼리를 실행해 updateTemp 가 그 쿼리를
  // 실제로 발행하는지는 검증하지 못했다. 여기서는 updateTemp 를 직접 호출한다.
  it('updateTemp 실제 호출: 이력·한도를 신규 매핑으로 승계한다', async () => {
    const mappingId = await seedMapping(2);
    const historyRepository = dataSource.getRepository(TestOrderDeliveryEntity);
    const history = await historyRepository.save(
      historyRepository.create({
        status: 'COMPLETE',
        orderProductMappingId: mappingId,
        deliveryMethod: 'MMS',
        deliveryTarget: '01011112222',
        sendRequestAt: new Date(),
        confirmedAt: new Date(),
        limitClaimed: true,
      } as any) as unknown as TestOrderDeliveryEntity,
    );

    await buildService().updateTemp(owner(), updateTempBody([{ id: mappingId, productId }]));

    // 옛 매핑은 삭제되고 새 매핑이 생성된다.
    const oldMapping = await mappingRepository.findOne({ where: { id: mappingId } });
    expect(oldMapping).toBeNull();

    const newMapping = await mappingRepository.findOneOrFail({
      where: { orderId, productId },
      order: { id: 'DESC' },
    });
    expect(newMapping.id).not.toBe(mappingId);
    expect(newMapping.testDeliveryCount).toBe(2); // 한도 승계 — 저장으로 리셋되지 않는다

    const carried = await historyRepository.findOneOrFail({ where: { id: history.id } });
    expect(carried.orderProductMappingId).toBe(newMapping.id); // 이력 승계
    expect(carried.deletedAt).toBeNull();
  });

  it('updateTemp 실제 호출: 삭제된 라인의 COMPLETE 이력은 정리하고 WAIT 은 남긴다', async () => {
    const keepId = await seedMapping(1);
    const dropId = await seedMapping(1);
    const historyRepository = dataSource.getRepository(TestOrderDeliveryEntity);

    const seedHistory = async (mappingId: number, status: string) =>
      (
        await historyRepository.save(
          historyRepository.create({
            status,
            orderProductMappingId: mappingId,
            deliveryMethod: 'MMS',
            deliveryTarget: '01011112222',
            sendRequestAt: new Date(),
            confirmedAt: status === 'COMPLETE' ? new Date() : null,
            limitClaimed: true,
          } as any) as unknown as TestOrderDeliveryEntity,
        )
      ).id;

    const keepHistoryId = await seedHistory(keepId, 'COMPLETE');
    const dropCompleteId = await seedHistory(dropId, 'COMPLETE');
    const dropWaitId = await seedHistory(dropId, 'WAIT');

    // dropId 라인을 빼고 저장한다.
    await buildService().updateTemp(owner(), updateTempBody([{ id: keepId, productId }]));

    const keepHistory = await historyRepository.findOneOrFail({ where: { id: keepHistoryId }, withDeleted: true });
    const dropComplete = await historyRepository.findOneOrFail({ where: { id: dropCompleteId }, withDeleted: true });
    const dropWait = await historyRepository.findOneOrFail({ where: { id: dropWaitId }, withDeleted: true });

    expect(keepHistory.deletedAt).toBeNull(); // 남은 라인 이력은 건드리지 않는다
    expect(dropComplete.deletedAt).not.toBeNull(); // 삭제 라인의 확정 이력은 정리
    expect(dropWait.deletedAt).toBeNull(); // WAIT 은 외부 발송 가능성이 있어 남긴다

    // 매핑이 삭제되면 잔류 정리가 이 행에 도달할 수 없으므로, 고아화 직전에 경보가 찍혀야 한다.
    expect(dropWait.opsEscalatedAt).not.toBeNull();
    // 남은 라인의 이력은 경보 대상이 아니다.
    expect(keepHistory.opsEscalatedAt).toBeNull();
  });

  // 승계로 매핑이 바뀐 이력은 WAIT 전환에서 0행이 되어 발송이 중단돼야 한다.
  it('승계로 매핑이 바뀌면 WAIT 전환이 0행이 되어 발송 전에 막힌다', async () => {
    const mappingId = await seedMapping(0);
    const historyRepository = dataSource.getRepository(TestOrderDeliveryEntity);
    const history = await historyRepository.save(
      historyRepository.create({
        status: 'TEMP',
        orderProductMappingId: mappingId,
        deliveryMethod: 'MMS',
        deliveryTarget: '01011112222',
        sendRequestAt: new Date(),
        limitClaimed: true,
      } as any) as unknown as TestOrderDeliveryEntity,
    );

    // updateTemp 가 재생성·승계한 상황을 만든다.
    await buildService().updateTemp(owner(), updateTempBody([{ id: mappingId, productId }]));

    const carried = await historyRepository.findOneOrFail({ where: { id: history.id } });
    expect(carried.orderProductMappingId).not.toBe(mappingId);

    // testDelivery 의 WAIT 전환과 동일한 쿼리. 요청 당시 id(mappingId)로는 잡히지 않아야 한다.
    const sendClaim = await historyRepository
      .createQueryBuilder()
      .update()
      .set({ status: IOrderDeliveryStatus.WAIT })
      .where('id = :id', { id: history.id })
      .andWhere('status = :temp', { temp: IOrderDeliveryStatus.TEMP })
      .andWhere('deleted_at IS NULL')
      .andWhere('order_product_mapping_id = :orderProductMappingId', { orderProductMappingId: mappingId })
      .execute();

    expect(sendClaim.affected).toBe(0);

    const stillTemp = await historyRepository.findOneOrFail({ where: { id: history.id } });
    expect(stillTemp.status).toBe(IOrderDeliveryStatus.TEMP); // 발송 권한을 얻지 못한다
  });

  it('setLock(pessimistic_write) 이 SELECT ... FOR UPDATE 로 컴파일된다', () => {
    // order.service.ts:4041 의 쿼리와 동일한 형태
    const [sql] = mappingRepository
      .createQueryBuilder('orderProductMapping')
      .setLock('pessimistic_write')
      .where('orderProductMapping.orderId = :orderId', { orderId })
      .getQueryAndParameters();

    expect(sql).toContain('FOR UPDATE');
  });

  // 리뷰 지적(락 순서 반전) 재현 검증.
  // updateTemp 는 order -> order_product_mapping -> test_order_delivery 순으로 잠근다.
  // 보상 경로(rollbackTestDelivery / discardStaleTestDeliveries)도 이력에 손대기 전에 매핑을 먼저 잠근다.
  // 두 경로가 같은 방향이면 서로 반대로 대기하는 사이클이 생기지 않는다.
  it('보상 경로와 updateTemp 가 같은 락 순서를 써서 데드락이 나지 않는다', async () => {
    const mappingId = await seedMapping(1);
    const historyRepository = dataSource.getRepository(TestOrderDeliveryEntity);
    const history = await historyRepository.save(
      historyRepository.create({
        status: 'TEMP',
        orderProductMappingId: mappingId,
        deliveryMethod: 'MMS',
        deliveryTarget: '01011112222',
        sendRequestAt: new Date(),
        limitClaimed: true,
      } as any) as unknown as TestOrderDeliveryEntity,
    );

    // 보상 경로 순서: order_product_mapping 잠금 -> test_order_delivery 소프트 삭제
    const compensator = dataSource.createQueryRunner();
    await compensator.connect();
    await compensator.query('SET SESSION innodb_lock_wait_timeout = 5');
    await compensator.startTransaction();
    await compensator.manager
      .createQueryBuilder(OrderProductMappingEntity, 'orderProductMapping')
      .setLock('pessimistic_write')
      .where('orderProductMapping.id = :id', { id: mappingId })
      .getOne();

    // updateTemp 순서: order -> order_product_mapping. 매핑에서 대기하게 된다(같은 방향이라 사이클 없음).
    const saver = dataSource.createQueryRunner();
    await saver.connect();
    await saver.query('SET SESSION innodb_lock_wait_timeout = 5');
    await saver.startTransaction();
    await saver.manager
      .createQueryBuilder(OrderEntity, 'order')
      .setLock('pessimistic_write')
      .where('order.id = :id', { id: orderId })
      .getOne();

    const saverWait = saver.manager
      .createQueryBuilder(OrderProductMappingEntity, 'orderProductMapping')
      .setLock('pessimistic_write')
      .where('orderProductMapping.id = :id', { id: mappingId })
      .getOne();

    // 보상 경로가 이력을 마저 정리하고 커밋한다. 매핑 잠금은 이미 이 트랜잭션이 쥐고 있으므로
    // 이력 단계에서 updateTemp 를 기다리지 않는다 = 데드락 사이클이 성립하지 않는다.
    await compensator.manager
      .createQueryBuilder()
      .softDelete()
      .from(TestOrderDeliveryEntity)
      .where('id = :id', { id: history.id })
      .execute();
    await compensator.commitTransaction();
    await compensator.release();

    // 보상이 커밋된 뒤 updateTemp 의 매핑 잠금이 풀려 정상 진행된다.
    let deadlock = false;
    try {
      await saverWait;
      await saver.commitTransaction();
    } catch (error: any) {
      deadlock = error?.code === 'ER_LOCK_DEADLOCK' || error?.code === 'ER_LOCK_WAIT_TIMEOUT';
      await saver.rollbackTransaction();
    }
    await saver.release();

    expect(deadlock).toBe(false);

    const removed = await historyRepository.findOneOrFail({ where: { id: history.id }, withDeleted: true });
    expect(removed.deletedAt).not.toBeNull();
  });

  it('잠금이 동시 한도 선점(+1) UPDATE 를 실제로 블로킹한다', async () => {
    const mappingId = await seedMapping(0);

    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    // updateTemp 의 잠금 읽기. 트랜잭션을 열어둔 채 유지한다.
    await runner.manager
      .createQueryBuilder(OrderProductMappingEntity, 'orderProductMapping')
      .setLock('pessimistic_write')
      .where('orderProductMapping.orderId = :orderId', { orderId })
      .getMany();

    // 다른 커넥션에서 testDelivery 의 한도 선점(+1) 을 시도한다.
    // 잠금이 걸려 있으면 이 UPDATE 는 대기하다 lock wait timeout 으로 실패해야 한다.
    //
    // 대기 시간은 이 커넥션의 SESSION 변수로 짧게 잡는다. SET GLOBAL 은 SUPER 권한이 필요하고
    // 이미 열린 커넥션에 적용되지 않아 기본 50초를 그대로 쓰게 된다.
    const waiter = dataSource.createQueryRunner();
    await waiter.connect();
    await waiter.query('SET SESSION innodb_lock_wait_timeout = 5');

    let blocked = false;
    let errorCode = '';
    const startedAt = Date.now();
    try {
      await waiter.manager
        .createQueryBuilder()
        .update(OrderProductMappingEntity)
        .set({ testDeliveryCount: () => 'test_delivery_count + 1' })
        .where('id = :id', { id: mappingId })
        .andWhere('test_delivery_count < :maxLimitCount', { maxLimitCount: 2 })
        .execute();
    } catch (error: any) {
      blocked = true;
      errorCode = error?.code ?? '';
    }
    const waitedMs = Date.now() - startedAt;
    await waiter.release();

    await runner.rollbackTransaction();
    await runner.release();

    // SESSION 변수가 실제로 적용됐는지 확인한다. 기본값(50초)으로 돌면 이 테스트가 느려지고,
    // 대기 시간이 의도와 다르다는 뜻이라 결과를 신뢰할 수 없다.
    expect(waitedMs).toBeLessThan(20_000);

    // 잠금이 실효하다면 동시 UPDATE 가 진입하지 못한다.
    expect(blocked).toBe(true);
    expect(errorCode).toBe('ER_LOCK_WAIT_TIMEOUT');
  });

  it('잠금 없이 읽으면 증가분이 유실된다 (대조군 — 잠금의 필요성)', async () => {
    const mappingId = await seedMapping(0);

    // 잠금 없는 읽기 (수정 전 코드의 find 와 동일한 격리 수준)
    const before = await mappingRepository.findOneByOrFail({ id: mappingId });
    expect(before.testDeliveryCount).toBe(0);

    // 읽은 뒤 다른 트랜잭션이 한도를 선점한다 (테스트 발송 1회)
    await dataSource
      .createQueryBuilder()
      .update(OrderProductMappingEntity)
      .set({ testDeliveryCount: () => 'test_delivery_count + 1' })
      .where('id = :id', { id: mappingId })
      .execute();

    // updateTemp 가 낡은 값(0)을 새 행에 승계하면 발송 1회가 사라진다.
    const carriedStaleValue = before.testDeliveryCount;
    const actual = await mappingRepository.findOneByOrFail({ id: mappingId });

    expect(actual.testDeliveryCount).toBe(1);
    expect(carriedStaleValue).toBe(0); // 유실 재현 — 잠금이 없으면 이 값이 승계된다
  });

  it('잠긴 트랜잭션이 커밋되면 대기하던 UPDATE 가 최신 값 위에서 진행된다', async () => {
    const mappingId = await seedMapping(1);

    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    await runner.manager
      .createQueryBuilder(OrderProductMappingEntity, 'orderProductMapping')
      .setLock('pessimistic_write')
      .where('orderProductMapping.orderId = :orderId', { orderId })
      .getMany();

    // 잠금 보유 중 승계 값을 기록 (updateTemp 가 새 행에 넣는 값)
    await runner.manager
      .createQueryBuilder()
      .update(OrderProductMappingEntity)
      .set({ testDeliveryCount: 1 })
      .where('id = :id', { id: mappingId })
      .execute();

    await runner.commitTransaction();
    await runner.release();

    // 잠금 해제 후에는 선점이 정상 진행된다.
    const claim = await dataSource
      .createQueryBuilder()
      .update(OrderProductMappingEntity)
      .set({ testDeliveryCount: () => 'test_delivery_count + 1' })
      .where('id = :id', { id: mappingId })
      .andWhere('test_delivery_count < :maxLimitCount', { maxLimitCount: 2 })
      .execute();

    expect(claim.affected).toBe(1);

    const after = await mappingRepository.findOneByOrFail({ id: mappingId });
    expect(after.testDeliveryCount).toBe(2); // 승계값 1 위에 +1 — 유실 없음
  });

  it('한도 소진 후에는 선점이 차단된다 (승계값이 실제로 한도로 작동)', async () => {
    // updateTemp 가 승계한 값이 2 라면, 이후 발송은 막혀야 한다.
    const mappingId = await seedMapping(2);

    const claim = await dataSource
      .createQueryBuilder()
      .update(OrderProductMappingEntity)
      .set({ testDeliveryCount: () => 'test_delivery_count + 1' })
      .where('id = :id', { id: mappingId })
      .andWhere('test_delivery_count < :maxLimitCount', { maxLimitCount: 2 })
      .execute();

    expect(claim.affected).toBe(0); // 저장으로 한도가 풀리지 않음
  });

  it('고아 정리는 COMPLETE 만 지우고 WAIT 은 남긴다', async () => {
    const mappingId = await seedMapping(0);
    const historyRepository = dataSource.getRepository(TestOrderDeliveryEntity);

    const seedHistory = async (status: string) =>
      (
        await historyRepository.save(
          historyRepository.create({
            status,
            orderProductMappingId: mappingId,
            deliveryMethod: 'MMS',
            deliveryTarget: '01011112222',
            sendRequestAt: new Date(),
            confirmedAt: status === 'COMPLETE' ? new Date() : null,
            limitClaimed: true,
          } as any) as unknown as TestOrderDeliveryEntity,
        )
      ).id;

    const completeId = await seedHistory('COMPLETE');
    const waitId = await seedHistory('WAIT');

    // updateTemp 의 고아 정리와 동일한 호출 (order.service.ts:4202)
    await historyRepository.softDelete({
      orderProductMappingId: In([mappingId]),
      status: Not(IOrderDeliveryStatus.WAIT),
    });

    const complete = await historyRepository.findOneOrFail({ where: { id: completeId }, withDeleted: true });
    const wait = await historyRepository.findOneOrFail({ where: { id: waitId }, withDeleted: true });

    expect(complete.deletedAt).not.toBeNull(); // 확정 이력은 정리됨
    expect(wait.deletedAt).toBeNull(); // 외부 발송이 나갔을 수 있는 건은 남는다
  });

  it('softDelete 가 test_order_delivery.deleted_at 을 채우고 조회에서 제외된다', async () => {
    const mappingId = await seedMapping(0);
    const historyRepository = dataSource.getRepository(TestOrderDeliveryEntity);

    const history = await historyRepository.save(
      historyRepository.create({
        status: 'COMPLETE',
        orderProductMappingId: mappingId,
        deliveryMethod: 'MMS',
        deliveryTarget: '01011112222',
        sendRequestAt: new Date(),
        confirmedAt: new Date(),
        limitClaimed: true,
      } as any) as unknown as TestOrderDeliveryEntity,
    );

    // updateTemp 의 고아 정리와 동일한 호출
    await historyRepository.softDelete({ orderProductMappingId: mappingId });

    // loadTestDeliveryHistories 는 withDeleted() 없이 조회한다 → 제외되어야 한다
    const visible = await historyRepository.find({ where: { orderProductMappingId: mappingId } });
    expect(visible).toHaveLength(0);

    // 행 자체는 남아 있고 deleted_at 만 채워진다 (마이그레이션 불필요 근거)
    const withDeleted = await historyRepository.find({
      where: { id: history.id },
      withDeleted: true,
    });
    expect(withDeleted).toHaveLength(1);
    expect(withDeleted[0].deletedAt).not.toBeNull();
  });
});
