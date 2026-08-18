import 'reflect-metadata';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';

import { UserEntity } from '../../entity/user.entity';
import { UserCompanyEntity } from '../../entity/user.company.entity';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { BrandEntity } from '../../entity/brand.entity';
import { ProductEntity } from '../../entity/product.entity';
import { OrderEntity } from '../../entity/order.entity';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderDeliveryRefundStatusEnum } from '../../delivery/interface/order.delivery.refund.status.enum';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { RefundService } from './refund.service';

dotenv.config();
jest.setTimeout(120_000);

const TEST_DB_NAME_PATTERN = /test/i;

const COMPANY_A = '환불집계 고객사A';
const COMPANY_B = '환불집계 고객사B';
const COMPANY_C = '환불집계 고객사C';

/**
 * 환불목록 상단 '총 환불금액'(totalRefundPrice) — 실 MySQL 검증.
 *
 * 합계는 목록 QueryBuilder 를 clone 해 `SUM(CAST(COALESCE(snapshot_product_price, product.price, 0) *
 * refund_ratio AS DECIMAL(20,4)) / 100)` 으로 낸다. 이 SQL 이 **실제로 그 컬럼들을 읽는지**(TypeORM property-path 치환,
 * alias, decimal 반환)와 **행 합과 일치하는지**는 repository mock 으로 잡히지 않는다
 * (mock 은 문자열만 비교하므로). 같은 이유로 만들어진 선례: settle.service.summary-settlefee.
 */
describe('RefundService.getList — totalRefundPrice DB 통합', () => {
  let dataSource: DataSource;
  let service: RefundService;

  const auditContext = { user: {} as ILoginUserInfo, ipAddress: '127.0.0.1' };

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

    // deliveryTarget/bankAccount 는 암호문이라 평문 픽스처를 그대로 읽도록 항등 stub 을 쓴다.
    const cipherStub = {
      safeDecryptDeliveryTarget: (v: string) => v,
      safeDecryptAccountNumber: (v: string) => v,
      encryptDeliveryTarget: (v: string) => v,
    } as unknown as CryptoCipher;

    service = new RefundService(
      cipherStub,
      { createLog: async () => undefined } as unknown as ActivityLogService,
      dataSource.getRepository(OrderDeliveryEntity),
    );

    await seedFixtures(dataSource);
  });

  afterAll(async () => {
    deleteDataSourceByName('default');
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('상품가가 주문 후 변경된 건이 섞여도 총합이 목록 행별 환불금액의 단순 합과 일치한다', async () => {
    const res = await service.getList({ page: 1, take: 10, userBusinessName: COMPANY_A } as any, auditContext);

    const rowSum = res.list.reduce((acc, row) => acc + row.refundPrice, 0);
    expect(res.totalCount).toBe(2);
    expect(rowSum).toBe(8000);
    expect(res.totalRefundPrice).toBe(rowSum);
    // live product.price(99999) 로 집계했다면 A-1 이 49999.5 가 되어 여기서 갈린다.
    expect(res.totalRefundPrice).toBe(8000);
  });

  // 어느 한쪽에 반올림이 들어가면 여기서만 갈린다 — 다른 픽스처는 전부 정수라 no-op 이다.
  it('환불금액이 소수로 떨어져도 총합이 행별 환불금액의 단순 합과 일치한다', async () => {
    const res = await service.getList({ page: 1, take: 10, userBusinessName: COMPANY_C } as any, auditContext);

    const rowSum = res.list.reduce((acc, row) => acc + row.refundPrice, 0);
    expect(rowSum).toBe(499.5);
    expect(res.totalRefundPrice).toBe(rowSum);
  });

  it('환불건이 아닌 행(refundStatus NULL)은 집계에 섞이지 않는다', async () => {
    const res = await service.getList({ page: 1, take: 10, userBusinessName: COMPANY_A } as any, auditContext);

    // A-3(snapshot=50000, 환불 아님)이 섞였다면 8000 을 넘는다.
    expect(res.totalRefundPrice).toBe(8000);
  });

  it('필터를 적용하면 적용 후 모집단 기준으로 값이 바뀐다', async () => {
    const all = await service.getList({ page: 1, take: 10 } as any, auditContext);
    const companyA = await service.getList({ page: 1, take: 10, userBusinessName: COMPANY_A } as any, auditContext);
    const progressOnly = await service.getList(
      { page: 1, take: 10, userBusinessName: COMPANY_A, refundStatus: OrderDeliveryRefundStatusEnum.PROGRESS } as any,
      auditContext,
    );

    expect(all.totalRefundPrice).toBe(15499.5); // A(8000) + B(7000) + C(499.5)
    expect(companyA.totalRefundPrice).toBe(8000);
    expect(progressOnly.totalRefundPrice).toBe(5000); // A-1 만 PROGRESS
  });

  it('페이지를 넘겨도 totalRefundPrice 는 같다 (페이지 무관)', async () => {
    const page1 = await service.getList({ page: 1, take: 1, userBusinessName: COMPANY_A } as any, auditContext);
    const page2 = await service.getList({ page: 2, take: 1, userBusinessName: COMPANY_A } as any, auditContext);

    expect(page1.list).toHaveLength(1);
    expect(page2.list).toHaveLength(1);
    expect(page1.totalRefundPrice).toBe(8000);
    expect(page2.totalRefundPrice).toBe(8000);
  });

  it('매칭 0건이면 null/undefined 가 아니라 0 이다', async () => {
    const res = await service.getList(
      { page: 1, take: 10, userBusinessName: '존재하지 않는 고객사' } as any,
      auditContext,
    );

    expect(res.totalCount).toBe(0);
    expect(res.totalRefundPrice).toBe(0);
  });
});

async function seedFixtures(dataSource: DataSource): Promise<void> {
  const suffix = Date.now();
  const companyRepo = dataSource.getRepository(UserCompanyEntity);
  const userRepo = dataSource.getRepository(UserEntity);
  const pcRepo = dataSource.getRepository(PartnerCompanyEntity);
  const brandRepo = dataSource.getRepository(BrandEntity);
  const productRepo = dataSource.getRepository(ProductEntity);
  const orderRepo = dataSource.getRepository(OrderEntity);
  const mappingRepo = dataSource.getRepository(OrderProductMappingEntity);
  const deliveryRepo = dataSource.getRepository(OrderDeliveryEntity);

  const partnerCompany = await pcRepo.save(
    pcRepo.create({
      code: `refund-pc-${suffix}`,
      businessNumber: `refund-biz-${suffix}`,
      businessName: '환불 협력사',
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
      code: `refund-brand-${suffix}`.slice(0, 20),
      nameKorean: '환불 브랜드',
      nameEnglish: 'Refund Brand',
      isUsed: true,
    } as any) as unknown as BrandEntity,
  );

  const createProduct = (name: string, price: number) =>
    productRepo.save(
      productRepo.create({
        code: `refund-product-${name}-${suffix}`,
        partnerCompanyId: partnerCompany.id,
        brandId: brand.id,
        name,
        price,
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

  const raisedProduct = await createProduct('가격인상상품', 99999);
  const legacyProduct = await createProduct('레거시상품', 3000);

  const createCustomer = async (businessName: string, tag: string) => {
    const company = await companyRepo.save(
      companyRepo.create({
        businessName,
        businessNumber: `refund-company-${tag}-${suffix}`,
        businessAddress: '서울',
        businessPhoneNumber: '0212345678',
      } as any) as unknown as UserCompanyEntity,
    );

    return userRepo.save(
      userRepo.create({
        companyId: company.id,
        settlementCode: '',
        email: `refund-${tag}-${suffix}@example.com`,
        password: 'password',
        isPasswordReset: false,
        lastActivityAt: new Date(),
        authority: 'CORPORATE_ADMIN',
        status: 'USED',
        personName: `환불담당-${tag}`,
        personPhoneNumber: '01000000000',
        personEmail: `refund-${tag}-${suffix}@example.com`,
        personCode: `refund-${tag}-${suffix}`,
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
  };

  const customerA = await createCustomer(COMPANY_A, 'a');
  const customerB = await createCustomer(COMPANY_B, 'b');
  const customerC = await createCustomer(COMPANY_C, 'c');

  const createMapping = async (userId: number, productId: number, snapshotProductPrice: number | null, tag: string) => {
    const order = await orderRepo.save(
      orderRepo.create({
        userId,
        code: `refund-order-${tag}-${suffix}`,
        status: 'DELIVERY_COMPLETE',
        type: 'GENERAL',
        eventName: '환불집계 검증',
        registerAt: new Date(),
        sendAmount: 0,
        settleAmount: 0,
        isSettleBalance: false,
        isNewBillingFlow: true,
        cardSurchargeApplied: false,
        isCreditExcess: false,
      } as any) as unknown as OrderEntity,
    );

    return mappingRepo.save(
      mappingRepo.create({
        orderId: order.id,
        productId,
        amount: 1,
        fee: null,
        priceAdjustment: null,
        topImagePath: '',
        midImagePath: '',
        sendMethod: 'ALIM_TALK',
        fromPhoneNumber: '0212345678',
        sendTitle: '제목',
        sendContent: '내용',
        sendRequestAt: new Date(),
        snapshotProductPrice,
        snapshotProductName: `주문시점 상품명-${tag}`,
      } as any) as unknown as OrderProductMappingEntity,
    );
  };

  const saveDelivery = (
    mappingId: number,
    refund: { refundStatus: OrderDeliveryRefundStatusEnum | null; refundRatio: number | null },
  ) =>
    deliveryRepo.save(
      deliveryRepo.create({
        status: 'COMPLETE',
        orderProductMappingId: mappingId,
        deliveryMethod: 'ALIM_TALK',
        deliveryTarget: '01011112222',
        originalDeliveryTarget: '01011112222',
        sendRequestAt: new Date(),
        actualSendAt: new Date(),
        refundStatus: refund.refundStatus,
        refundRatio: refund.refundRatio,
        refundRegisterAt: refund.refundStatus ? new Date() : null,
      } as any),
    );

  // A-1: 주문시점 10000 박제 / 현재 상품가 99999, 50% 환불 → 5000
  const a1 = await createMapping(customerA.id, raisedProduct.id, 10000, 'a1');
  await saveDelivery(a1.id, { refundStatus: OrderDeliveryRefundStatusEnum.PROGRESS, refundRatio: 50 });

  // A-2: 레거시(스냅샷 없음) → live product.price 3000, 100% 환불 → 3000
  const a2 = await createMapping(customerA.id, legacyProduct.id, null, 'a2');
  await saveDelivery(a2.id, { refundStatus: OrderDeliveryRefundStatusEnum.COMPLETE, refundRatio: 100 });

  // A-3: 환불건이 아님 → 집계/목록 모두에서 빠져야 한다
  const a3 = await createMapping(customerA.id, raisedProduct.id, 50000, 'a3');
  await saveDelivery(a3.id, { refundStatus: null, refundRatio: null });

  // B-1: 다른 고객사 → 고객사명 필터로 배제되는지 확인
  const b1 = await createMapping(customerB.id, raisedProduct.id, 7000, 'b1');
  await saveDelivery(b1.id, { refundStatus: OrderDeliveryRefundStatusEnum.PROGRESS, refundRatio: 100 });

  // C-1: 결과가 소수인 유일한 건(999 * 50% = 499.5). 나머지가 전부 정수라 SQL·JS 어느 쪽에 반올림이
  // 들어가도 다른 픽스처로는 드러나지 않는다.
  const c1 = await createMapping(customerC.id, raisedProduct.id, 999, 'c1');
  await saveDelivery(c1.id, { refundStatus: OrderDeliveryRefundStatusEnum.PROGRESS, refundRatio: 50 });
}
