import 'reflect-metadata';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as mysql from 'mysql2/promise';
import { DataSource, Repository } from 'typeorm';
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
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { DeliveryBatchService } from './delivery.batch.service';

dotenv.config();
jest.setTimeout(120_000);

const TEST_DB_NAME_PATTERN = /test/i;

/**
 * r2/c3: 발송 배치 claim(claimWaitDeliveries)이 external(order.type=EXTERNAL) 발송건과
 * 비동기 PENDING(report_state) 건을 절대 claim 하지 않음을 실DB로 검증한다.
 * external dispatch 와 batch 의 동일 delivery 중복 issue/발송 차단 보장(원자 제외).
 */
describe('DeliveryBatchService.claimWaitDeliveries DB 제외 (external / PENDING)', () => {
  let dataSource: DataSource;
  let deliveryRepository: Repository<OrderDeliveryEntity>;
  let service: any;

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
      extra: { connectionLimit: 5 },
    });

    await dataSource.initialize();
    addTransactionalDataSource(dataSource);

    deliveryRepository = dataSource.getRepository(OrderDeliveryEntity);

    service = Object.create(DeliveryBatchService.prototype);
    service.orderDeliveryRepository = deliveryRepository;
  });

  afterAll(async () => {
    deleteDataSourceByName('default');
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('external 건·PENDING 건은 claim 제외, 일반 WAIT 건만 claim 된다', async () => {
    const suffix = Date.now();
    const past = new Date(Date.now() - 60_000);

    const userRepo = dataSource.getRepository(UserEntity);
    const pcRepo = dataSource.getRepository(PartnerCompanyEntity);
    const brandRepo = dataSource.getRepository(BrandEntity);
    const productRepo = dataSource.getRepository(ProductEntity);
    const orderRepo = dataSource.getRepository(OrderEntity);
    const mappingRepo = dataSource.getRepository(OrderProductMappingEntity);

    const customer = await userRepo.save(
      userRepo.create({
        companyId: null,
        settlementCode: '',
        email: `cust-${suffix}@example.com`,
        password: 'password',
        isPasswordReset: false,
        lastActivityAt: new Date(),
        authority: 'CORPORATE_ADMIN',
        status: 'USED',
        personName: 'cust',
        personPhoneNumber: '01000000000',
        personEmail: `cust-${suffix}@example.com`,
        personCode: `cust-${suffix}`,
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
    const pc = await pcRepo.save(
      pcRepo.create({
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
    const brand = await brandRepo.save(
      brandRepo.create({
        code: `brand-${suffix}`,
        nameKorean: '테스트 브랜드',
        nameEnglish: 'Test Brand',
        isUsed: true,
      } as any) as unknown as BrandEntity,
    );
    const product = await productRepo.save(
      productRepo.create({
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

    // 주문 1건 + delivery 1건 생성 헬퍼 (orderType / reportState 가변). seq 로 order code 유일성 보장.
    let seq = 0;
    const seedDelivery = async (orderType: string, reportState: string | null) => {
      seq += 1;
      const order = await orderRepo.save(
        orderRepo.create({
          userId: customer.id,
          code: `order-${orderType}-${reportState ?? 'null'}-${suffix}-${seq}`,
          status: 'DELIVERY_CONFIRMED',
          type: orderType,
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
      const mapping = await mappingRepo.save(
        mappingRepo.create({
          orderId: order.id,
          productId: product.id,
          amount: 1,
          topImagePath: '',
          midImagePath: '',
          sendMethod: 'ALIM_TALK',
          fromPhoneNumber: '0212345678',
          sendTitle: '테스트 제목',
          sendContent: '테스트 내용',
          sendRequestAt: past,
        } as any) as unknown as OrderProductMappingEntity,
      );
      const delivery = await deliveryRepository.save(
        deliveryRepository.create({
          status: 'WAIT',
          orderProductMappingId: mapping.id,
          deliveryMethod: 'ALIM_TALK',
          deliveryTarget: '01011112222',
          sendRequestAt: past,
          claimedAt: null,
          reportState: reportState,
        } as any) as unknown as OrderDeliveryEntity,
      );
      return delivery.id;
    };

    const generalId = await seedDelivery('GENERAL', null); // claim 대상
    const externalId = await seedDelivery('EXTERNAL', null); // 제외(external)
    const pendingId = await seedDelivery('GENERAL', 'PENDING'); // 제외(비동기 확인대기)

    const claimedAt = new Date();
    const affected = await service.claimWaitDeliveries(claimedAt);

    const general = await deliveryRepository.findOneByOrFail({ id: generalId });
    const external = await deliveryRepository.findOneByOrFail({ id: externalId });
    const pending = await deliveryRepository.findOneByOrFail({ id: pendingId });

    expect(affected).toBe(1); // 일반 WAIT 1건만
    expect(general.claimedAt).not.toBeNull(); // 일반 건은 claim 됨
    expect(external.claimedAt).toBeNull(); // external 은 절대 claim 안 됨 (중복 issue/발송 차단)
    expect(pending.claimedAt).toBeNull(); // PENDING 은 reportSweep 소관, batch 미claim

    // 동시 dispatch 안전성: 신규 일반 2건을 두 워커가 동시에 claim → 각 행은 정확히 1회만 claim,
    // external 은 여전히 제외. (claimedAt IS NULL 조건의 DB 직렬화로 중복 claim 차단)
    const concA = await seedDelivery('GENERAL', null);
    const concB = await seedDelivery('GENERAL', null);
    const externalId2 = await seedDelivery('EXTERNAL', null);
    const t1 = new Date(Date.now() + 1000);
    const t2 = new Date(Date.now() + 2000);
    const [a1, a2] = await Promise.all([service.claimWaitDeliveries(t1), service.claimWaitDeliveries(t2)]);

    const cA = await deliveryRepository.findOneByOrFail({ id: concA });
    const cB = await deliveryRepository.findOneByOrFail({ id: concB });
    const ext2 = await deliveryRepository.findOneByOrFail({ id: externalId2 });

    expect(a1 + a2).toBe(2); // 신규 일반 2건이 두 워커에 걸쳐 정확히 한 번씩만 claim
    expect(cA.claimedAt).not.toBeNull();
    expect(cB.claimedAt).not.toBeNull();
    expect(ext2.claimedAt).toBeNull(); // external 동시 상황에서도 제외 유지

    // completion drift 복구(실DB): order=DELIVERY_CONFIRMED 인데 delivery 전건 터미널(COMPLETE)
    // → reconcileSettlementDrift 의 HAVING 집계 쿼리가 후보로 잡아 DELIVERY_COMPLETE 로 전이.
    // (정산조건/reportState 무관 검증 — 본 주문 user 는 POST_PAYMENT, reportState=NULL)
    service.orderRepository = orderRepo;
    const driftDeliveryId = await seedDelivery('GENERAL', null);
    const driftDelivery = await deliveryRepository.findOneByOrFail({ id: driftDeliveryId });
    const driftMapping = await mappingRepo.findOneByOrFail({ id: driftDelivery.orderProductMappingId });
    await deliveryRepository.update({ id: driftDeliveryId }, { status: 'COMPLETE' } as any);

    await service.reconcileSettlementDrift();

    const driftOrder = await orderRepo.findOneByOrFail({ id: driftMapping.orderId });
    expect(driftOrder.status).toBe('DELIVERY_COMPLETE'); // 전건 터미널 → 완료 전이(POST_PAYMENT 도 대상)
  });
});
