import 'reflect-metadata';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { addTransactionalDataSource, deleteDataSourceByName, initializeTransactionalContext } from 'typeorm-transactional';

import { UserEntity } from '../../entity/user.entity';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { BrandEntity } from '../../entity/brand.entity';
import { ProductEntity } from '../../entity/product.entity';
import { OrderEntity } from '../../entity/order.entity';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';

dotenv.config();
jest.setTimeout(120_000);

const TEST_DB_NAME_PATTERN = /test/i;

describe('OrderProductMapping partner settle snapshot DB insert', () => {
  let dataSource: DataSource;

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
  });

  afterAll(async () => {
    deleteDataSourceByName('default');
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('협력사 정산 스냅샷 컬럼을 실제 insert 후 다시 조회할 수 있다', async () => {
    const suffix = Date.now();
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
        email: `snapshot-cust-${suffix}@example.com`,
        password: 'password',
        isPasswordReset: false,
        lastActivityAt: new Date(),
        authority: 'CORPORATE_ADMIN',
        status: 'USED',
        personName: 'snapshot-cust',
        personPhoneNumber: '01000000000',
        personEmail: `snapshot-cust-${suffix}@example.com`,
        personCode: `snapshot-cust-${suffix}`,
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
        code: `snapshot-pc-${suffix}`,
        businessNumber: `snapshot-biz-${suffix}`,
        businessName: '스냅샷 협력사',
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
        code: `snap-brand-${suffix}`.slice(0, 20),
        nameKorean: '스냅샷 브랜드',
        nameEnglish: 'Snapshot Brand',
        isUsed: true,
      } as any) as unknown as BrandEntity,
    );
    const product = await productRepo.save(
      productRepo.create({
        code: `snapshot-product-${suffix}`,
        partnerCompanyId: pc.id,
        brandId: brand.id,
        name: '스냅샷 상품',
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
    const order = await orderRepo.save(
      orderRepo.create({
        userId: customer.id,
        code: `snapshot-order-${suffix}`,
        status: 'DELIVERY_CONFIRMED',
        type: 'GENERAL',
        eventName: '스냅샷 검증',
        registerAt: new Date(),
        sendAmount: 10_000,
        settleAmount: 0,
        isSettleBalance: false,
        isNewBillingFlow: true,
        cardSurchargeApplied: false,
        isCreditExcess: false,
      } as any) as unknown as OrderEntity,
    );

    const inserted = await mappingRepo.save(
      mappingRepo.create({
        orderId: order.id,
        productId: product.id,
        amount: 1,
        topImagePath: '',
        midImagePath: '',
        sendMethod: 'ALIM_TALK',
        fromPhoneNumber: '0212345678',
        sendTitle: '스냅샷 제목',
        sendContent: '스냅샷 내용',
        sendRequestAt: new Date(),
        snapshotProductPrice: 10_000,
        partnerSettleFee: 12,
        partnerSettlePriceAdjustment: IPriceAdjustment.DISCOUNT,
      } as any) as unknown as OrderProductMappingEntity,
    );

    const reloaded = await mappingRepo.findOneByOrFail({ id: inserted.id });

    expect(reloaded.partnerSettleFee).toBe(12);
    expect(reloaded.partnerSettlePriceAdjustment).toBe(IPriceAdjustment.DISCOUNT);
  });
});
