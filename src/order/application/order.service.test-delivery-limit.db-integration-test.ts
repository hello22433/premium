import 'reflect-metadata';
import * as dotenv from 'dotenv';
import * as mysql from 'mysql2/promise';
import * as path from 'path';
import { BadRequestException } from '@nestjs/common';
import { DataSource, IsNull, Repository } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';
import { BrandEntity } from '../../entity/brand.entity';
import { OrderEntity } from '../../entity/order.entity';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { TestOrderDeliveryEntity } from '../../entity/test.order.delivery.entity';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { ProductEntity } from '../../entity/product.entity';
import { UserEntity } from '../../entity/user.entity';
import { UserViewScopeEntity, ViewScopeType } from '../../entity/user.view.scope.entity';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { IOrderSendMethod } from '../interface/order.send.method';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';
import { OrderService } from './order.service';
import { IPartnerCompanySettleCondition } from '../../partner_company/interface/partner.company.settle.condition';
import { IPartnerCompanySettleMethod } from '../../partner_company/interface/partner.company.settle.method';
import { IPartnerCompanyStatus } from '../../partner_company/interface/partner.company.status';
import { IProductType } from '../../product/interface/product.type';
import { IProductUseStatus } from '../../product/interface/product.status';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserSettleCondition } from '../../user/interface/user.settle.condition';
import { IUserSettleMethod } from '../../user/interface/user.settle.method';
import { IUserStatus } from '../../user/interface/user.status';

jest.mock('../../delivery/infra/delivery.create.coupon.image', () => ({
  DeliveryCreateCouponImage: jest.fn().mockResolvedValue({ path: 'test-coupon.png' }),
}));

dotenv.config();

jest.setTimeout(120_000);

const TEST_DB_NAME_PATTERN = /test/i;
const MAX_LIMIT_COUNT = 2;

/**
 * 테스트 발송 한도 선점을 실제 DB 로 검증한다.
 *
 * mock 스펙(order.service.test-delivery-limit.spec.ts)은 affected 값을 주입해 로직만 본다.
 * 여기서는 조건부 UPDATE(test_delivery_count < 2) 를 실제 InnoDB 가 직렬화하는지,
 * 즉 잔여 1회에서 동시 2건이 들어와도 정확히 1건만 발송되는지를 확인한다.
 */
describe('OrderService.testDelivery DB concurrency', () => {
  let dataSource: DataSource;
  let mappingRepository: Repository<OrderProductMappingEntity>;
  let testOrderDeliveryRepository: Repository<TestOrderDeliveryEntity>;

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
      extra: {
        connectionLimit: 5,
      },
    });

    await dataSource.initialize();
    addTransactionalDataSource(dataSource);

    mappingRepository = dataSource.getRepository(OrderProductMappingEntity);
    testOrderDeliveryRepository = dataSource.getRepository(TestOrderDeliveryEntity);
  });

  afterAll(async () => {
    deleteDataSourceByName('default');
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('잔여 1회에서 동시 2건 요청 시 정확히 1건만 발송되고 한도는 2를 넘지 않는다', async () => {
    // 이미 1회 사용해 잔여 1회인 상태에서 시작한다.
    const fixture = await seedTestDeliveryOrder(dataSource, MAX_LIMIT_COUNT - 1);
    const service = createService(dataSource, 150);

    const request = () =>
      service.testDelivery(
        { id: fixture.customer.id, authority: IUserAuthority.CORPORATE_ADMIN } as any,
        {
          orderId: fixture.order.id,
          orderProductMappingId: fixture.mapping.id,
          deliveryTarget: '01011112222',
        } as any,
      );

    const results = await Promise.allSettled([request(), request()]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(BadRequestException);
    expect(rejected.reason.message).toContain('테스트발송은 상품당 최대 2회입니다.');

    // 발송은 1건만 일어났다.
    expect((service as any).deliveryBatchService.oneSend).toHaveBeenCalledTimes(1);

    // 한도는 조건부 UPDATE 로 직렬화되어 상한을 넘지 않는다.
    const refreshedMapping = await mappingRepository.findOneByOrFail({ id: fixture.mapping.id });
    expect(refreshedMapping.testDeliveryCount).toBe(MAX_LIMIT_COUNT);

    // 성공 확정된 이력도 1건뿐이다(차단된 요청은 이력을 남기지 않는다).
    const histories = await testOrderDeliveryRepository.find({
      where: { orderProductMappingId: fixture.mapping.id },
    });
    expect(histories).toHaveLength(1);
    expect(histories[0].status).toBe(IOrderDeliveryStatus.COMPLETE);
  });

  /**
   * 잔류 정리는 이력 삭제와 한도 회수가 별도 쿼리라 한 트랜잭션으로 묶여야 한다.
   * 갈라지면 이력만 지워지고 한도는 남는데, 원 요청은 WAIT 전환 0행을 보고 "이미 회수됐다"고
   * 판단해 보상을 생략하므로 한도가 영구 누수된다. 실제 롤백이 일어나는지는 DB 로만 확인할 수 있다.
   */
  describe('잔류 정리 원자성', () => {
    it('한도 회수가 실패하면 이력 삭제도 함께 롤백된다 (부분 반영 없음)', async () => {
      const fixture = await seedTestDeliveryOrder(dataSource, MAX_LIMIT_COUNT);
      // grace(600초)를 넘긴 TEMP 잔류를 심는다. 한도는 이 건이 선점한 상태(count=2).
      const stale = await seedStaleTempDelivery(dataSource, fixture.mapping.id, true);

      const service = createService(dataSource);
      // 한도 회수 UPDATE 만 실패시킨다. 이력 삭제는 이미 수행된 뒤다.
      const mappingRepo = (service as any).orderProductMappingRepository;
      const originalCreateQueryBuilder = mappingRepo.createQueryBuilder.bind(mappingRepo);
      let failedOnce = false;
      // createQueryBuilder() 는 SelectQueryBuilder 를 주고 .update() 가 별개의 UpdateQueryBuilder 를
      // 반환하므로, execute 는 update() 결과 쪽에 걸어야 한다.
      mappingRepo.createQueryBuilder = (...args: any[]) => {
        const selectBuilder = originalCreateQueryBuilder(...args);
        const originalUpdate = selectBuilder.update.bind(selectBuilder);
        selectBuilder.update = (...updateArgs: any[]) => {
          const updateBuilder = originalUpdate(...updateArgs);
          const originalExecute = updateBuilder.execute.bind(updateBuilder);
          updateBuilder.execute = async () => {
            // 한도 회수 UPDATE 는 set({ testDeliveryCount: () => 'GREATEST(...)' }) 형태다.
            let isRecovery = false;
            try {
              const valueSet: any = updateBuilder.getValueSet?.();
              const expression = valueSet?.testDeliveryCount;
              isRecovery = typeof expression === 'function' && String(expression()).includes('GREATEST');
            } catch {
              isRecovery = false;
            }
            if (!failedOnce && isRecovery) {
              failedOnce = true;
              throw new Error('한도 회수 UPDATE 실패(주입)');
            }
            return originalExecute();
          };
          return updateBuilder;
        };
        return selectBuilder;
      };

      await service
        .testDelivery(
          { id: fixture.customer.id, authority: IUserAuthority.CORPORATE_ADMIN } as any,
          {
            orderId: fixture.order.id,
            orderProductMappingId: fixture.mapping.id,
            deliveryTarget: '01011112222',
          } as any,
        )
        .catch(() => undefined);

      expect(failedOnce).toBe(true);

      // 회수가 실패했으므로 이력 삭제도 롤백되어야 한다. 둘 다 원래대로여야 다음 요청이 다시 정리할 수 있다.
      const staleRow = await testOrderDeliveryRepository.findOne({
        where: { id: stale.id },
        withDeleted: true,
      });
      expect(staleRow?.deletedAt ?? null).toBeNull();

      const refreshedMapping = await mappingRepository.findOneByOrFail({ id: fixture.mapping.id });
      expect(refreshedMapping.testDeliveryCount).toBe(MAX_LIMIT_COUNT);
    });

    it('정상 경로에서는 TEMP 잔류 삭제와 한도 회수가 함께 반영된다', async () => {
      const fixture = await seedTestDeliveryOrder(dataSource, MAX_LIMIT_COUNT);
      const stale = await seedStaleTempDelivery(dataSource, fixture.mapping.id, true);

      const service = createService(dataSource);

      // 잔류 1건이 회수되어 잔여 1회가 생기므로 이 요청은 발송에 성공한다.
      await expect(
        service.testDelivery(
          { id: fixture.customer.id, authority: IUserAuthority.CORPORATE_ADMIN } as any,
          {
            orderId: fixture.order.id,
            orderProductMappingId: fixture.mapping.id,
            deliveryTarget: '01011112222',
          } as any,
        ),
      ).resolves.toBeUndefined();

      const staleRow = await testOrderDeliveryRepository.findOne({
        where: { id: stale.id },
        withDeleted: true,
      });
      expect(staleRow?.deletedAt).not.toBeNull();

      // 회수(-1) 후 이번 요청이 선점(+1) 하므로 한도는 그대로 2다.
      const refreshedMapping = await mappingRepository.findOneByOrFail({ id: fixture.mapping.id });
      expect(refreshedMapping.testDeliveryCount).toBe(MAX_LIMIT_COUNT);
    });

    /**
     * 발송 실패 보상도 이력 삭제와 한도 차감이 별도 쿼리라 원자적이어야 한다.
     * 보상만 반영되면 TEMP 행이 남아 잔류 정리가 같은 건을 또 -1 해 2회 제한을 우회한다.
     */
    it('보상 중 한도 차감이 실패하면 이력 삭제도 함께 롤백된다', async () => {
      const fixture = await seedTestDeliveryOrder(dataSource, 0);
      const service = createService(dataSource);
      // 발송을 실패시켜 보상 경로로 보낸다.
      (service as any).deliveryBatchService.oneSend = jest.fn(async () => false);

      const mappingRepo = (service as any).orderProductMappingRepository;
      const originalCreateQueryBuilder = mappingRepo.createQueryBuilder.bind(mappingRepo);
      let failedOnce = false;
      mappingRepo.createQueryBuilder = (...args: any[]) => {
        const selectBuilder = originalCreateQueryBuilder(...args);
        const originalUpdate = selectBuilder.update.bind(selectBuilder);
        selectBuilder.update = (...updateArgs: any[]) => {
          const updateBuilder = originalUpdate(...updateArgs);
          const originalExecute = updateBuilder.execute.bind(updateBuilder);
          updateBuilder.execute = async () => {
            // 보상 차감은 set({ testDeliveryCount: () => 'test_delivery_count - 1' }) 형태다.
            let isCompensation = false;
            try {
              const valueSet: any = updateBuilder.getValueSet?.();
              const expression = valueSet?.testDeliveryCount;
              isCompensation = typeof expression === 'function' && String(expression()).includes('- 1');
            } catch {
              isCompensation = false;
            }
            if (!failedOnce && isCompensation) {
              failedOnce = true;
              throw new Error('보상 차감 실패(주입)');
            }
            return originalExecute();
          };
          return updateBuilder;
        };
        return selectBuilder;
      };

      await expect(
        service.testDelivery(
          { id: fixture.customer.id, authority: IUserAuthority.CORPORATE_ADMIN } as any,
          {
            orderId: fixture.order.id,
            orderProductMappingId: fixture.mapping.id,
            deliveryTarget: '01011112222',
          } as any,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(failedOnce).toBe(true);

      // 보상이 실패했으므로 이력 삭제도 롤백되어야 한다(부분 반영 없음).
      const rows = await testOrderDeliveryRepository.find({
        where: { orderProductMappingId: fixture.mapping.id },
        withDeleted: true,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].deletedAt ?? null).toBeNull();

      // 남는 상태는 WAIT 이다. WAIT 전환은 oneSend 직전에 이미 커밋됐고, 롤백되는 것은
      // 보상 TX 안의 소프트 삭제뿐이라 TEMP 로 되돌아가지 않는다.
      expect(rows[0].status).toBe(IOrderDeliveryStatus.WAIT);

      // 선점(+1)은 그대로 남는다. WAIT 은 발송 여부 불명이라 잔류 정리가 자동 회수하지 않고
      // ops_escalated_at 경보로 운영이 확인한다(자동 회수하면 이미 도달한 건을 재발송할 수 있다).
      const refreshedMapping = await mappingRepository.findOneByOrFail({ id: fixture.mapping.id });
      expect(refreshedMapping.testDeliveryCount).toBe(1);
    });

    /**
     * 보상 차감은 "이 요청이 실제로 이력을 지웠을 때"만 해야 한다.
     * 발송 실패 처리 사이에 다른 인스턴스의 잔류 정리가 같은 행을 지우며 한도를 이미 회수했는데
     * 여기서 또 -1 하면 남의 선점분까지 깎여 2회 제한을 넘겨 발송할 수 있다.
     */
    it('이력이 이미 정리·회수된 뒤라면 보상 차감을 하지 않는다 (이중 회수 방지)', async () => {
      // 이미 성공한 테스트 발송 1건이 한도를 쓰고 있는 상태에서 시작한다.
      const fixture = await seedTestDeliveryOrder(dataSource, 1);
      const service = createService(dataSource);

      // 발송 실패 직전에 다른 인스턴스의 잔류 정리가 이 건을 삭제·회수한 상황을 만든다.
      (service as any).deliveryBatchService.oneSend = jest.fn(async () => {
        const inFlight = await testOrderDeliveryRepository.findOneOrFail({
          where: { orderProductMappingId: fixture.mapping.id, deletedAt: IsNull() },
        });
        await testOrderDeliveryRepository.softDelete(inFlight.id);
        await mappingRepository
          .createQueryBuilder()
          .update()
          .set({ testDeliveryCount: () => 'GREATEST(test_delivery_count - 1, 0)' })
          .where('id = :id', { id: fixture.mapping.id })
          .execute();
        return false;
      });

      await expect(
        service.testDelivery(
          { id: fixture.customer.id, authority: IUserAuthority.CORPORATE_ADMIN } as any,
          {
            orderId: fixture.order.id,
            orderProductMappingId: fixture.mapping.id,
            deliveryTarget: '01011112222',
          } as any,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // 선점(+1) → 잔류 정리 회수(-1) 로 이미 상쇄됐다. 보상까지 타면 0 이 되어
      // 앞서 성공한 1건의 선점이 사라지고 기업관리자가 총 3회 발송할 수 있게 된다.
      const refreshedMapping = await mappingRepository.findOneByOrFail({ id: fixture.mapping.id });
      expect(refreshedMapping.testDeliveryCount).toBe(1);
    });

    it('관리자 잔류(한도 미선점)는 삭제되지만 한도를 회수하지 않는다', async () => {
      const fixture = await seedTestDeliveryOrder(dataSource, MAX_LIMIT_COUNT);
      const stale = await seedStaleTempDelivery(dataSource, fixture.mapping.id, false);

      const service = createService(dataSource);

      // 관리자 잔류는 한도를 올린 적이 없으므로 회수되지 않는다 → 여전히 한도 초과로 차단된다.
      await expect(
        service.testDelivery(
          { id: fixture.customer.id, authority: IUserAuthority.CORPORATE_ADMIN } as any,
          {
            orderId: fixture.order.id,
            orderProductMappingId: fixture.mapping.id,
            deliveryTarget: '01011112222',
          } as any,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const staleRow = await testOrderDeliveryRepository.findOne({
        where: { id: stale.id },
        withDeleted: true,
      });
      expect(staleRow?.deletedAt).not.toBeNull();

      const refreshedMapping = await mappingRepository.findOneByOrFail({ id: fixture.mapping.id });
      expect(refreshedMapping.testDeliveryCount).toBe(MAX_LIMIT_COUNT);
    });
  });

  it('한도 소진 상태에서는 발송 없이 차단되고 한도가 더 오르지 않는다', async () => {
    const fixture = await seedTestDeliveryOrder(dataSource, MAX_LIMIT_COUNT);
    const service = createService(dataSource);

    await expect(
      service.testDelivery(
        { id: fixture.customer.id, authority: IUserAuthority.CORPORATE_ADMIN } as any,
        {
          orderId: fixture.order.id,
          orderProductMappingId: fixture.mapping.id,
          deliveryTarget: '01011112222',
        } as any,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect((service as any).deliveryBatchService.oneSend).not.toHaveBeenCalled();

    const refreshedMapping = await mappingRepository.findOneByOrFail({ id: fixture.mapping.id });
    expect(refreshedMapping.testDeliveryCount).toBe(MAX_LIMIT_COUNT);
  });
});

/**
 * 실제 repository 를 물린 OrderService.
 * 외부 발송(oneSend)만 mock 이며, sendDelayMs 로 동시 요청 구간을 겹치게 한다.
 */
function createService(dataSource: DataSource, sendDelayMs = 0): OrderService {
  const service = Object.create(OrderService.prototype) as any;
  service.orderRepository = dataSource.getRepository(OrderEntity);
  service.userRepository = dataSource.getRepository(UserEntity);
  service.userViewScopeRepository = dataSource.getRepository(UserViewScopeEntity);
  service.orderProductMappingRepository = dataSource.getRepository(OrderProductMappingEntity);
  service.orderDeliveryRepository = dataSource.getRepository(OrderDeliveryEntity);
  service.testOrderDeliveryRepository = dataSource.getRepository(TestOrderDeliveryEntity);
  service.logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn(), debug: jest.fn() };
  service.cryptoCipher = {
    encryptDeliveryTarget: (value: string) => value,
    safeDecryptDeliveryTarget: (value: string) => value,
  };
  service.deliveryBatchService = {
    oneSend: jest.fn(async () => {
      if (sendDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, sendDelayMs));
      }
      return true;
    }),
  };
  return service as OrderService;
}

async function seedTestDeliveryOrder(dataSource: DataSource, testDeliveryCount: number) {
  // code 컬럼 길이 제한이 있어 짧게 만든다.
  const suffix = `${(Date.now() % 1_000_000).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const userRepository = dataSource.getRepository(UserEntity);
  const viewScopeRepository = dataSource.getRepository(UserViewScopeEntity);
  const partnerCompanyRepository = dataSource.getRepository(PartnerCompanyEntity);
  const brandRepository = dataSource.getRepository(BrandEntity);
  const productRepository = dataSource.getRepository(ProductEntity);
  const orderRepository = dataSource.getRepository(OrderEntity);
  const mappingRepository = dataSource.getRepository(OrderProductMappingEntity);

  const customer = await userRepository.save(
    userRepository.create(buildUser(`customer-${suffix}`, IUserAuthority.CORPORATE_ADMIN)),
  );
  // assertOrderInViewScope 가 통과하도록 본인 주문만 보는 스코프를 부여한다.
  await viewScopeRepository.save(
    viewScopeRepository.create({
      userId: customer.id,
      scopeType: ViewScopeType.SELF,
      deptIds: null,
    } as any),
  );

  const partnerCompany = await partnerCompanyRepository.save(
    partnerCompanyRepository.create({
      code: `pc-${suffix}`,
      corporateNumber: null,
      businessNumber: `biz-${suffix}`,
      businessName: '테스트 협력사',
      businessAddress: '서울',
      businessPhoneNumber: '0212345678',
      personName: '담당자',
      personPhoneNumber: '01000000000',
      personEmail: 'partner@example.com',
      settleCondition: IPartnerCompanySettleCondition.POST_PAYMENT,
      settleDay: 1,
      settleMethod: IPartnerCompanySettleMethod.CASH,
      maximumLimit: 1_000_000,
      bankName: '은행',
      bankNumber: '0000',
      status: IPartnerCompanyStatus.ACTIVE,
      type: null,
    } as any) as unknown as PartnerCompanyEntity,
  );
  const brand = await brandRepository.save(
    brandRepository.create({
      code: `brand-${suffix}`,
      nameKorean: '테스트 브랜드',
      nameEnglish: 'Test Brand',
      isUsed: true,
    } as any) as unknown as BrandEntity,
  );
  const product = await productRepository.save(
    productRepository.create({
      code: `product-${suffix}`,
      partnerCompanyCode: null,
      partnerCompanyId: partnerCompany.id,
      brandId: brand.id,
      name: '테스트 상품',
      price: 10_000,
      expireDay: 30,
      galaxiaDuration: null,
      category: 'A',
      classificationId: null,
      settleMethod: 'PER_PRODUCT',
      settlePercent: 0,
      imagePath: '',
      type: IProductType.GENERAL,
      couponMethod: 'NONE',
      memo: null,
      useStatus: IProductUseStatus.USE,
      isCancelable: true,
      color: null,
      status: null,
    } as any) as unknown as ProductEntity,
  );
  // 발송완료 건도 테스트 발송이 허용된다(개발지원요청사항 4차 15번).
  const order = await orderRepository.save(
    orderRepository.create({
      userId: customer.id,
      operationUserId: null,
      clientUserId: null,
      code: `order-${suffix}`,
      status: IOrderStatus.DELIVERY_COMPLETE,
      type: IOrderType.GENERAL,
      eventName: '테스트 이벤트',
      registerAt: new Date(),
      sendAmount: 10_000,
      settleAmount: 0,
      settledAmountSnapshot: null,
      ssgEventId: null,
      settleStatus: null,
      isSettleBalance: false,
      isNewBillingFlow: true,
      cardSurchargeApplied: false,
      isCreditExcess: false,
      cancelReason: null,
      canceledAt: null,
    } as any) as unknown as OrderEntity,
  );
  const mapping = await mappingRepository.save(
    mappingRepository.create({
      orderId: order.id,
      productId: product.id,
      amount: 1,
      testDeliveryCount,
      topImagePath: '',
      midImagePath: '',
      settleDiscountType: null,
      priceAdjustment: null,
      fee: null,
      sendMethod: IOrderSendMethod.ALIM_TALK,
      sendTailText: null,
      requestToDestroyPersonalInfoDay: null,
      fromPhoneNumber: '0212345678',
      sendTitle: '테스트 제목',
      sendContent: '테스트 내용',
      fromEmail: null,
      emailSendType: null,
      useEmailContent: null,
      sendRequestAt: new Date(),
      sendType: 'IMMEDIATE',
      encourageDay: null,
      galaxiaDuration: null,
    } as any) as unknown as OrderProductMappingEntity,
  );

  return { customer, order, mapping };
}

/**
 * grace(600초)를 넘긴 TEMP 잔류 이력을 심는다.
 * created_at 은 @CreateDateColumn 이라 save 로는 과거 시각을 넣을 수 없어 UPDATE 로 되돌린다.
 */
async function seedStaleTempDelivery(dataSource: DataSource, orderProductMappingId: number, limitClaimed: boolean) {
  const repository = dataSource.getRepository(TestOrderDeliveryEntity);
  const saved = await repository.save(
    repository.create({
      status: IOrderDeliveryStatus.TEMP,
      orderProductMappingId,
      deliveryMethod: IOrderSendMethod.ALIM_TALK,
      deliveryTarget: '01011112222',
      imagePath: 'test-coupon.png',
      sendRequestAt: new Date(),
      expireAt: null,
      barCode: '999999',
      personalCode: '999999',
      limitClaimed,
    } as any) as unknown as TestOrderDeliveryEntity,
  );

  await repository
    .createQueryBuilder()
    .update()
    .set({ createdAt: () => 'NOW(6) - INTERVAL 1200 SECOND' })
    .where('id = :id', { id: saved.id })
    .execute();

  return saved;
}

function buildUser(emailPrefix: string, authority: IUserAuthority): Partial<UserEntity> {
  return {
    companyId: null,
    settlementCode: '',
    departmentId: null,
    email: `${emailPrefix}@example.com`,
    password: 'password',
    isPasswordReset: false,
    passwordChangedAt: null,
    authority,
    status: IUserStatus.USED,
    lastActivityAt: new Date(),
    personName: emailPrefix,
    personPhoneNumber: '01000000000',
    personEmail: `${emailPrefix}@example.com`,
    personCode: emailPrefix,
    businessType: null,
    corporateNumber: '',
    isHeadPerson: false,
    ip: null,
    settleCondition: IUserSettleCondition.POST_PAYMENT,
    settleMethod: IUserSettleMethod.CASH,
    bankName: '',
    bankNumber: '',
    cardName: '',
    cardNumber: '',
    balance: 0,
    fromPhoneNumber: null,
    settlePeriodCondition: null,
    settlePeriodCount: null,
    allSettleAmount: 0,
    serviceAmount: 0,
    duplicatePhoneLimit: 0,
    authorityList: null,
    apiKeyHash: null,
  };
}
