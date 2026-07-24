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
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { SettleService } from './settle.service';

dotenv.config();
jest.setTimeout(120_000);

const TEST_DB_NAME_PATTERN = /test/i;

/**
 * getUserSummary(정산관리 고객사 요약 footer)의 settleFee 반영 회귀 — 실 MySQL 검증.
 *
 * 배경: buildUserSettleQueryBuilder 는 forSum=true 일 때 성능을 이유로 orderDeliveries JOIN 을
 * 생략했다. 그 결과 calculateMappingSettlementBaseAmount 에서 mapping.orderDeliveries 가
 * 미로드(undefined→[])되어 hasDeliveryFee=false 균일 분기로 빠지고, 발송건별 settleFee(SSG
 * 차등정산)를 통째로 무시해 요약 총액이 정가로 부풀었다(목록 행 합과 불일치).
 *
 * 이 결함은 "쿼리가 관계를 로드하는가"의 문제라 repository mock 유닛테스트로는 잡히지 않는다
 * (mock 이 알아서 deliveries 를 채워주므로). 그래서 실 DB 로 검증한다.
 *
 * 픽스처: 상품가 3335원 매핑 1건(mapping.fee=null), 발송건 2개(10% / 11% 차등정산).
 *   - 정상(차등 반영): (3335-round(333.5)=3001) + (3335-round(366.85)=2968) = 5969
 *   - 버그(정가 균일):  3335 × amount(2) = 6670
 */
describe('SettleService.getUserSummary — settleFee 반영 (forSum 쿼리 orderDeliveries 로드) DB 통합', () => {
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

  it('차등정산(발송건별 settleFee) 주문의 요약 총액이 정가 균일이 아니라 실제 정산액과 일치한다', async () => {
    const suffix = Date.now();
    const userRepo = dataSource.getRepository(UserEntity);
    const pcRepo = dataSource.getRepository(PartnerCompanyEntity);
    const brandRepo = dataSource.getRepository(BrandEntity);
    const productRepo = dataSource.getRepository(ProductEntity);
    const orderRepo = dataSource.getRepository(OrderEntity);
    const mappingRepo = dataSource.getRepository(OrderProductMappingEntity);
    const deliveryRepo = dataSource.getRepository(OrderDeliveryEntity);

    const customer = await userRepo.save(
      userRepo.create({
        companyId: null,
        settlementCode: '',
        email: `summary-cust-${suffix}@example.com`,
        password: 'password',
        isPasswordReset: false,
        lastActivityAt: new Date(),
        authority: 'CORPORATE_ADMIN',
        status: 'USED',
        personName: 'summary-cust',
        personPhoneNumber: '01000000000',
        personEmail: `summary-cust-${suffix}@example.com`,
        personCode: `summary-cust-${suffix}`,
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
        code: `summary-pc-${suffix}`,
        businessNumber: `summary-biz-${suffix}`,
        businessName: '요약 협력사',
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
        code: `sum-brand-${suffix}`.slice(0, 20),
        nameKorean: '요약 브랜드',
        nameEnglish: 'Summary Brand',
        isUsed: true,
      } as any) as unknown as BrandEntity,
    );

    const product = await productRepo.save(
      productRepo.create({
        code: `summary-product-${suffix}`,
        partnerCompanyId: pc.id,
        brandId: brand.id,
        name: '요약 상품',
        price: 3335,
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
        code: `summary-order-${suffix}`,
        status: 'DELIVERY_COMPLETE',
        type: 'GENERAL',
        eventName: '요약 검증',
        registerAt: new Date(),
        sendAmount: 6670,
        settleAmount: 5969,
        isSettleBalance: false,
        isNewBillingFlow: true,
        cardSurchargeApplied: false,
        isCreditExcess: false,
      } as any) as unknown as OrderEntity,
    );

    // 차등정산 매핑: mapping.fee=null 이고 요율은 발송건별 settleFee 에만 존재
    const mapping = await mappingRepo.save(
      mappingRepo.create({
        orderId: order.id,
        productId: product.id,
        amount: 2,
        fee: null,
        priceAdjustment: null,
        topImagePath: '',
        midImagePath: '',
        sendMethod: 'ALIM_TALK',
        fromPhoneNumber: '0212345678',
        sendTitle: '제목',
        sendContent: '내용',
        sendRequestAt: new Date(),
        snapshotProductPrice: 3335,
      } as any) as unknown as OrderProductMappingEntity,
    );

    const baseDelivery = {
      status: 'COMPLETE',
      orderProductMappingId: mapping.id,
      deliveryMethod: 'ALIM_TALK',
      deliveryTarget: '01011112222',
      originalDeliveryTarget: '01011112222',
      sendRequestAt: new Date(),
      actualSendAt: new Date(),
      replacedFromId: null,
      settlePriceAdjustment: IPriceAdjustment.DISCOUNT,
    };
    await deliveryRepo.save(deliveryRepo.create({ ...baseDelivery, settleFee: 10 } as any));
    await deliveryRepo.save(deliveryRepo.create({ ...baseDelivery, settleFee: 11 } as any));

    // 실제 서비스 메서드 호출 (orderRepository 만 실 repo 로 주입 — getUserSummary 가 쓰는 유일한 의존성)
    const service = Object.create(SettleService.prototype) as SettleService;
    (service as any).orderRepository = orderRepo;

    const summary = await service.getUserSummary({
      startAt: '2000-01-01',
      endAt: '2100-12-31',
    } as any);

    // 차등정산이 반영돼야 한다: 3001 + 2968 = 5969
    expect(summary.totalSettlePriceSum).toBe(5969);
    // 버그(정가 균일 3335×2)면 6670 이 나온다 — orderDeliveries 미로드 회귀 방지
    expect(summary.totalSettlePriceSum).not.toBe(6670);
    // 발송금액(사용자 컬럼 합)은 그대로
    expect(summary.totalDeliveryPriceSum).toBe(6670);
  });

  /**
   * D3-52 이중합산 방지 — 폐기 후 재발행(replaced-CANCEL 원본 제외)이 실 MySQL 에서도 동작하는지.
   *
   * forSum 쿼리는 orderDeliveries 를 innerJoinAndSelect 가 아니라 5개 컬럼만 addSelect 한다
   * (id/settleFee/settlePriceAdjustment/couponStatus/replacedFromId). 이 테스트는 그 중
   * couponStatus 와 bigint replacedFromId 가 실제로 하이드레이트되어 buildSettlementDisplayLines
   * 의 제외 로직이 발동함을 증명한다. 특히 replacedFromId 는 bigint 라 드라이버가 string 으로
   * 돌려주므로, util 의 Number() 정규화가 실 DB 값에 대해서도 맞는지 확인한다.
   *
   * 픽스처(상품가 3335, mapping.fee=null):
   *   - 원본  settleFee=10, couponStatus=CANCEL, replacedFromId=null      → 재발행돼 제외 대상
   *   - 재발행 settleFee=10, couponStatus=NOT_USED, replacedFromId=원본id  → 생존(3001)
   *   - 정상  settleFee=11, couponStatus=NOT_USED, replacedFromId=null     → 생존(2968)
   *   정상(제외 적용):   3001 + 2968 = 5969
   *   버그(제외 미적용): 3001(원본) + 3001(재발행) + 2968 = 8970  ← 이중합산
   */
  it('폐기 후 재발행된 CANCEL 원본을 제외해 요약 총액이 이중합산(8970)이 아니라 5969 다', async () => {
    const suffix = `${Date.now()}-reissue`;
    const eventName = `재발행검증-${suffix}`;
    const userRepo = dataSource.getRepository(UserEntity);
    const pcRepo = dataSource.getRepository(PartnerCompanyEntity);
    const brandRepo = dataSource.getRepository(BrandEntity);
    const productRepo = dataSource.getRepository(ProductEntity);
    const orderRepo = dataSource.getRepository(OrderEntity);
    const mappingRepo = dataSource.getRepository(OrderProductMappingEntity);
    const deliveryRepo = dataSource.getRepository(OrderDeliveryEntity);

    const customer = await userRepo.save(
      userRepo.create({
        companyId: null,
        settlementCode: '',
        email: `reissue-cust-${suffix}@example.com`,
        password: 'password',
        isPasswordReset: false,
        lastActivityAt: new Date(),
        authority: 'CORPORATE_ADMIN',
        status: 'USED',
        personName: 'reissue-cust',
        personPhoneNumber: '01000000000',
        personEmail: `reissue-cust-${suffix}@example.com`,
        personCode: `reissue-cust-${suffix}`,
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
        code: `reissue-pc-${suffix}`,
        businessNumber: `reissue-biz-${suffix}`,
        businessName: '재발행 협력사',
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
        code: `re-brand-${suffix}`.slice(0, 20),
        nameKorean: '재발행 브랜드',
        nameEnglish: 'Reissue Brand',
        isUsed: true,
      } as any) as unknown as BrandEntity,
    );

    const product = await productRepo.save(
      productRepo.create({
        code: `reissue-product-${suffix}`,
        partnerCompanyId: pc.id,
        brandId: brand.id,
        name: '재발행 상품',
        price: 3335,
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
        code: `reissue-order-${suffix}`,
        status: 'DELIVERY_COMPLETE',
        type: 'GENERAL',
        eventName,
        registerAt: new Date(),
        sendAmount: 6670,
        settleAmount: 5969,
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
        amount: 2,
        fee: null,
        priceAdjustment: null,
        topImagePath: '',
        midImagePath: '',
        sendMethod: 'ALIM_TALK',
        fromPhoneNumber: '0212345678',
        sendTitle: '제목',
        sendContent: '내용',
        sendRequestAt: new Date(),
        snapshotProductPrice: 3335,
      } as any) as unknown as OrderProductMappingEntity,
    );

    const baseDelivery = {
      status: 'COMPLETE',
      orderProductMappingId: mapping.id,
      deliveryMethod: 'ALIM_TALK',
      deliveryTarget: '01011112222',
      originalDeliveryTarget: '01011112222',
      sendRequestAt: new Date(),
      actualSendAt: new Date(),
      settlePriceAdjustment: IPriceAdjustment.DISCOUNT,
    };

    // 원본(10%): 폐기(CANCEL) 후 재발행돼 제외 대상
    const original = await deliveryRepo.save(
      deliveryRepo.create({ ...baseDelivery, settleFee: 10, couponStatus: 'CANCEL', replacedFromId: null } as any),
    );
    // 재발행(10%): 원본 id 를 replacedFromId 로 승계 → 원본을 제외시키는 신호
    await deliveryRepo.save(
      deliveryRepo.create({
        ...baseDelivery,
        settleFee: 10,
        couponStatus: 'NOT_USED',
        replacedFromId: (original as any).id,
      } as any),
    );
    // 정상(11%): 무참조 생존건
    await deliveryRepo.save(
      deliveryRepo.create({ ...baseDelivery, settleFee: 11, couponStatus: 'NOT_USED', replacedFromId: null } as any),
    );

    const service = Object.create(SettleService.prototype) as SettleService;
    (service as any).orderRepository = orderRepo;

    // 이 주문만 집계하도록 고유 eventName 으로 필터 (앞 테스트가 만든 주문과 격리)
    const summary = await service.getUserSummary({
      startAt: '2000-01-01',
      endAt: '2100-12-31',
      eventName,
    } as any);

    // 원본(CANCEL, 대체됨) 제외 → 3001 + 2968 = 5969
    expect(summary.totalSettlePriceSum).toBe(5969);
    // 제외 미적용(이중합산)이면 8970 — bigint replacedFromId(string) 하이드레이트/정규화 회귀 방지
    expect(summary.totalSettlePriceSum).not.toBe(8970);
  });
});
