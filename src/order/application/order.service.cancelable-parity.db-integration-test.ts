import 'reflect-metadata';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as mysql from 'mysql2/promise';
import { ConflictException } from '@nestjs/common';
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
import { IOrderType } from '../interface/order.type';
import { evaluateDeliveryCancelable } from '../domain/delivery.cancelable';
import { OrderService } from './order.service';

dotenv.config();
jest.setTimeout(180_000);

const TEST_DB_NAME_PATTERN = /test/i;

/**
 * 술어(evaluateDeliveryCancelable, 화면 표시용)와 SQL 게이트(findCancelableDeliveryIds, 권위값)의
 * **조건집합이 일치하는지 실 DB 로 교차검증**한다 (197-16 리뷰 architect / pr-test M-3).
 *
 * 두 구현은 각자의 단위 스펙(delivery.cancelable.spec / cancelable-deliveries.spec)으로만 고정돼
 * 있어, 한쪽에만 조건을 추가/변경하면 **양쪽 스펙이 각자 통과**해 drift 가 조용히 흘러간다.
 * 여기서는 각 조건을 하나씩 위반하는 발송건을 같은 주문에 심고, **동일한 now** 로:
 *   - findCancelableDeliveryIds(orderId, now)  → SQL 이 취소가능으로 본 id 집합
 *   - evaluateDeliveryCancelable(delivery, type, now) → 술어가 취소가능으로 본 값
 * 을 구해 `술어.cancelable === (id ∈ SQL집합)` 를 발송건마다 단언한다.
 * 8번째 조건을 한쪽에만 넣으면 이 대조가 깨진다.
 *
 * ※ order-level 게이트(SSG 등)는 findCancelableDeliveryIds 에 없고 조립부(getDetail)에서
 *   판정하므로 이 parity 의 대상이 아니다. 여기서는 발송건 축(7조건)만 대조한다.
 *   EXTERNAL 은 SQL(o.type != EXTERNAL)·술어 양쪽에 있으므로 포함한다.
 *
 * 실행: npm run test:db (DATABASE_DATABASE 이름에 test 포함 필요)
 */
describe('OrderService cancelable — 술어 ↔ SQL parity (실 DB)', () => {
  let dataSource: DataSource;
  let deliveryRepository: Repository<OrderDeliveryEntity>;
  let service: any;

  let customerId: number;
  let productId: number;
  const productPrice = 10_000;
  const now = new Date();

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

    const suffix = Date.now();
    const customer = await dataSource.getRepository(UserEntity).save({
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
    } as any);
    customerId = (customer as any).id;

    const pc = await dataSource.getRepository(PartnerCompanyEntity).save({
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
    } as any);
    const brand = await dataSource.getRepository(BrandEntity).save({
      code: `brand-${suffix}`,
      nameKorean: '테스트 브랜드',
      nameEnglish: 'Test Brand',
      isUsed: true,
    } as any);
    const product = await dataSource.getRepository(ProductEntity).save({
      code: `product-${suffix}`,
      partnerCompanyId: (pc as any).id,
      brandId: (brand as any).id,
      name: '테스트 상품',
      price: productPrice,
      expireDay: 30,
      category: 'A',
      settleMethod: 'PER_PRODUCT',
      settlePercent: 0,
      imagePath: '',
      type: 'GENERAL',
      couponMethod: 'NONE',
      useStatus: 'USE',
      isCancelable: true,
    } as any);
    productId = (product as any).id;

    service = Object.create(OrderService.prototype);
    service.orderDeliveryRepository = deliveryRepository;
  });

  afterAll(async () => {
    deleteDataSourceByName('default');
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  let orderSeq = 0;
  const futureSendAt = new Date(now.getTime() + 60 * 60 * 1000); // 컷오프 넉넉히 통과
  const withinCutoffSendAt = new Date(now.getTime() + 5 * 60 * 1000); // 컷오프(10분) 이내

  const seedOrder = async (type: IOrderType, deliveryOverrides: Array<Partial<OrderDeliveryEntity>>) => {
    orderSeq += 1;
    const order = await dataSource.getRepository(OrderEntity).save({
      userId: customerId,
      code: `order-parity-${Date.now()}-${orderSeq}`,
      status: 'DELIVERY_CONFIRMED',
      type,
      eventName: 'cancelable parity',
      registerAt: new Date(),
      sendAmount: productPrice,
      settleAmount: productPrice,
      isNewBillingFlow: true,
      cardSurchargeApplied: false,
    } as any);
    const mapping = await dataSource.getRepository(OrderProductMappingEntity).save({
      orderId: (order as any).id,
      productId,
      amount: deliveryOverrides.length,
      topImagePath: '',
      midImagePath: '',
      sendRequestAt: futureSendAt,
      snapshotProductPrice: productPrice,
    } as any);

    const ids: number[] = [];
    for (let i = 0; i < deliveryOverrides.length; i += 1) {
      const d = await deliveryRepository.save({
        orderProductMappingId: (mapping as any).id,
        status: 'WAIT',
        deliveryMethod: 'MMS',
        deliveryTarget: `0100000${String(i).padStart(4, '0')}`,
        couponStatus: 'NOT_USED',
        sendRequestAt: futureSendAt,
        actualSendAt: null,
        claimedAt: null,
        couponIssuedAt: null,
        barCode: null,
        reportState: null,
        ...deliveryOverrides[i],
      } as any);
      ids.push(Number((d as any).id));
    }
    return { orderId: (order as any).id as number, ids };
  };

  it('발송건 7조건 각각을 위반한 건에서 술어.cancelable === (id ∈ findCancelableDeliveryIds)', async () => {
    // index 0 = 전 조건 충족(취소가능), 1~7 = 조건을 하나씩 위반
    const overrides: Array<Partial<OrderDeliveryEntity>> = [
      {}, // 0: 취소 가능
      { status: 'COMPLETE' as any }, // 1: status != WAIT
      { actualSendAt: now } as any, // 2: 이미 발송
      { claimedAt: now } as any, // 3: 배치 선점
      { couponIssuedAt: now } as any, // 4: 발급됨(coupon)
      { barCode: 'ABC123' } as any, // 5: 발급됨(barcode)
      { reportState: 'PENDING' as any }, // 6: 리포트 시작
      { sendRequestAt: withinCutoffSendAt } as any, // 7: 컷오프 이내
    ];
    const { orderId, ids } = await seedOrder(IOrderType.GENERAL, overrides);

    const sqlIds = new Set<number>(await service.findCancelableDeliveryIds(orderId, now));
    const loaded = await deliveryRepository.findByIds(ids);
    const byId = new Map(loaded.map((r) => [Number(r.id), r]));

    // index 0 만 취소가능, 나머지는 불가 — SQL 과 술어가 동일하게 판정해야 한다.
    expect(sqlIds.has(ids[0])).toBe(true);
    for (let i = 1; i < ids.length; i += 1) {
      expect(sqlIds.has(ids[i])).toBe(false);
    }
    for (const id of ids) {
      const predicate = evaluateDeliveryCancelable(byId.get(id) as any, IOrderType.GENERAL, now);
      expect(predicate.cancelable).toBe(sqlIds.has(id));
    }
  });

  it('EXTERNAL 주문은 전 조건을 충족해도 술어·SQL 모두 취소불가 (o.type != EXTERNAL 축)', async () => {
    const { orderId, ids } = await seedOrder(IOrderType.EXTERNAL, [{}]);
    const sqlIds = new Set<number>(await service.findCancelableDeliveryIds(orderId, now));
    const loaded = await deliveryRepository.findByIds(ids);

    expect(sqlIds.has(ids[0])).toBe(false); // SQL 이 EXTERNAL 배제
    const predicate = evaluateDeliveryCancelable(loaded[0] as any, IOrderType.EXTERNAL, now);
    expect(predicate.cancelable).toBe(false);
    expect(predicate.cancelable).toBe(sqlIds.has(ids[0]));
  });

  /**
   * 관리자 리뷰 HIGH — 조회~갱신 창에서 쿠폰이 발급되면 CAS 가 막아야 한다.
   *
   * 조회(findCancelableDeliveryIds) 시점엔 전 조건을 만족하던 행이, UPDATE 직전에 발급 신호만
   * 생기는 상황을 재현한다(status 는 WAIT, claimed_at/actual_send_at 은 NULL 그대로 — 즉 종전
   * CAS 조건 4개로는 걸러지지 않는 조합). 발급 신호를 CAS 가 직접 보지 않으면 이미 발급된 쿠폰이
   * 취소되고 환불까지 나간다. affected 불일치 → ConflictException → 그 행은 WAIT 로 남아야 한다.
   */
  it.each([
    ['coupon_issued_at', { couponIssuedAt: new Date() }],
    ['bar_code', { barCode: 'ISSUED-PIN' }],
    ['report_state', { reportState: 'PENDING' }],
  ])('조회 후 %s 가 생기면 CAS 가 취소를 거부한다 (발급 신호 재검증)', async (_label, mutation) => {
    const { orderId, ids } = await seedOrder(IOrderType.GENERAL, [{}]);

    // 조회 단계 통과 확인 (창이 열리기 전)
    const before = new Set<number>(await service.findCancelableDeliveryIds(orderId, now));
    expect(before.has(ids[0])).toBe(true);

    // ── 창 안에서 발급 신호만 생긴다 (status/claimed_at/actual_send_at 은 그대로) ──
    await deliveryRepository.update(ids[0], mutation as any);

    const svc: any = Object.create(OrderService.prototype);
    svc.orderDeliveryRepository = deliveryRepository;
    svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    await expect(svc.cancelDeliveriesIfStillWaiting(orderId, ids, '사유', new Date())).rejects.toBeInstanceOf(
      ConflictException,
    );

    const after = await deliveryRepository.findByIds(ids);
    expect(after[0].status).toBe('WAIT'); // 취소되지 않았다
  });
});
