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
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';

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

    // 잠금 대기가 테스트를 오래 붙잡지 않도록 짧게 잡는다.
    await dataSource.query('SET GLOBAL innodb_lock_wait_timeout = 5');

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

  it('setLock(pessimistic_write) 이 SELECT ... FOR UPDATE 로 컴파일된다', () => {
    // order.service.ts:4041 의 쿼리와 동일한 형태
    const [sql] = mappingRepository
      .createQueryBuilder('orderProductMapping')
      .setLock('pessimistic_write')
      .where('orderProductMapping.orderId = :orderId', { orderId })
      .getQueryAndParameters();

    expect(sql).toContain('FOR UPDATE');
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
    let blocked = false;
    let errorCode = '';
    try {
      await dataSource
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

    await runner.rollbackTransaction();
    await runner.release();

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

  it('고아 정리는 COMPLETE 만 지우고 WAIT 은 남긴다 (ops 경보 보존)', async () => {
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
    expect(wait.deletedAt).toBeNull(); // 발송 여부 불명 건은 남아야 경보 대상으로 유지된다

    // ops 경보 쿼리(deleted_at IS NULL)가 여전히 WAIT 건을 본다
    const escalatable = await historyRepository
      .createQueryBuilder('h')
      .where('h.order_product_mapping_id = :mappingId', { mappingId })
      .andWhere('h.status = :wait', { wait: IOrderDeliveryStatus.WAIT })
      .andWhere('h.deleted_at IS NULL')
      .getCount();
    expect(escalatable).toBe(1);
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
