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
import { EarlyDestroyRequestEntity, EarlyDestroyRequestStatus } from '../../entity/early.destroy.request.entity';
import { EarlyDestroyRequestItemEntity } from '../../entity/early.destroy.request.item.entity';
import { OrderService } from './order.service';

dotenv.config();
jest.setTimeout(120_000);

const TEST_DB_NAME_PATTERN = /test/i;

/**
 * OrderService.loadEarlyDestroyedAtMap 을 실DB 로 검증한다.
 *
 * 왜 모킹 유닛테스트가 아니라 통합테스트인가 —
 *   이 메서드의 분기는 `item.orderDeliveryId !== null` 이다. DB 를 경유하면 NULL 이 `null` 로
 *   하이드레이션되어 '매핑 전체' 분기로 정확히 들어가지만, 리포지토리를 모킹하고 객체를 손으로
 *   만들면서 그 필드를 **생략**하면 `undefined !== null` 이 참이라 '단건' 분기로 빠진다.
 *   즉 모킹 테스트는 실제와 다른 코드를 검증하게 된다. 이 메서드에 한해 실DB 가 유일하게
 *   정직한 검증 수단이다.
 *
 * 이 맵이 틀리면 고객사 대외문서(파기확인서·발송완료 보고서)에 잘못된 파기일이 인쇄된다.
 * 두 방향 모두 위험하다:
 *   · 실적을 놓치면 → 이미 지운 건에 최대 5년 뒤 미래 날짜 (리뷰 HIGH-1)
 *   · 실적을 과잉 적용하면 → 살아있는 PII 에 과거 파기일 (허위 증명, 더 눈에 안 띈다)
 *
 * 실행 방법 (⚠ dropSchema: true — 전용 test DB 에서만):
 *   PowerShell:  $env:DATABASE_DATABASE='epopkon_test'; npm run test:db
 *   bash:        DATABASE_DATABASE=epopkon_test npm run test:db
 */
describe('OrderService.loadEarlyDestroyedAtMap (실DB)', () => {
  let dataSource: DataSource;
  let deliveryRepository: Repository<OrderDeliveryEntity>;
  let requestRepository: Repository<EarlyDestroyRequestEntity>;
  let itemRepository: Repository<EarlyDestroyRequestItemEntity>;
  let service: any;

  let productId: number;
  let customerId: number;

  const ymd = (d: Date | undefined) =>
    d ? `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}` : undefined;

  beforeAll(async () => {
    initializeTransactionalContext();
    deleteDataSourceByName('default');

    const database = process.env.DATABASE_DATABASE;
    if (!database || !TEST_DB_NAME_PATTERN.test(database)) {
      throw new Error(
        'DB 통합테스트는 이름에 test 가 포함된 DATABASE_DATABASE 에서만 실행할 수 있습니다. ' +
          "예: $env:DATABASE_DATABASE='epopkon_test'; npm run test:db",
      );
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
    requestRepository = dataSource.getRepository(EarlyDestroyRequestEntity);
    itemRepository = dataSource.getRepository(EarlyDestroyRequestItemEntity);

    // OrderService 는 생성자 의존성이 30개 가까워 정공법으로 세울 수 없다.
    // 이 메서드가 실제로 쓰는 리포지토리 2개만 꽂는다(기존 db-integration-test 와 같은 방식).
    service = Object.create(OrderService.prototype);
    service.earlyDestroyRequestRepository = requestRepository;
    service.orderDeliveryRepository = deliveryRepository;
    service.logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };

    const suffix = Date.now();
    const userRepo = dataSource.getRepository(UserEntity);
    const pcRepo = dataSource.getRepository(PartnerCompanyEntity);
    const brandRepo = dataSource.getRepository(BrandEntity);
    const productRepo = dataSource.getRepository(ProductEntity);

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
    customerId = customer.id;

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
        expireDay: 1826,
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
  });

  // 로거 목이 beforeAll 에서 한 번만 만들어지므로 호출 이력이 케이스 간에 누적된다.
  // 초기화하지 않으면 앞선 케이스가 남긴 error 로 뒤 케이스의 단언이 영구 통과한다.
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    deleteDataSourceByName('default');
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  /**
   * 주문 1건 + 매핑 1건을 만든다. 발송건은 seedDelivery 로 따로 붙인다 —
   * 조기파기 검증은 '한 매핑 아래 발송건 N개'가 필요하기 때문이다(매핑 전체 펼치기, 형제 미오염).
   */
  let seq = 0;
  const seedOrder = async (): Promise<{ orderId: number; mappingId: number }> => {
    seq += 1;
    const orderRepo = dataSource.getRepository(OrderEntity);
    const mappingRepo = dataSource.getRepository(OrderProductMappingEntity);

    const order = await orderRepo.save(
      orderRepo.create({
        userId: customerId,
        code: `order-edm-${seq}-${Date.now()}`,
        status: 'DELIVERY_COMPLETE',
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
    const mapping = await mappingRepo.save(
      mappingRepo.create({
        orderId: order.id,
        productId,
        amount: 1,
        topImagePath: '',
        midImagePath: '',
        sendMethod: 'ALIM_TALK',
        fromPhoneNumber: '0212345678',
        sendTitle: '테스트 제목',
        sendContent: '테스트 내용',
        sendRequestAt: new Date(),
        requestToDestroyPersonalInfoDay: 180,
      } as any) as unknown as OrderProductMappingEntity,
    );
    return { orderId: order.id, mappingId: mapping.id };
  };

  /**
   * 발송건 1건.
   *
   * ⚠️ createdAt 을 명시할 수 있게 둔 이유 — 펼치기 로직이 `createdAt <= executedAt` 을 보므로,
   *    "발송 → 파기" 라는 실제 시간 순서를 픽스처가 재현해야 한다. 그냥 두면 createdAt 이 '지금'
   *    이라 과거 executedAt 보다 뒤가 되어, 정상 로직인데도 전부 제외된다.
   *    @CreateDateColumn 은 INSERT 시 자동 설정되므로 raw UPDATE 로 덮는다.
   */
  const seedDelivery = async (
    mappingId: number,
    opts: { softDeleted?: boolean; createdAt?: Date } = {},
  ): Promise<number> => {
    const delivery = await deliveryRepository.save(
      deliveryRepository.create({
        status: 'COMPLETE',
        orderProductMappingId: mappingId,
        deliveryMethod: 'ALIM_TALK',
        deliveryTarget: '01011112222',
        sendRequestAt: new Date(),
        couponStatus: 'NOT_USED',
      } as any) as unknown as OrderDeliveryEntity,
    );
    if (opts.createdAt) {
      await dataSource.query('UPDATE order_delivery SET created_at = ? WHERE id = ?', [opts.createdAt, delivery.id]);
    }
    if (opts.softDeleted) await deliveryRepository.softDelete(delivery.id);
    return delivery.id;
  };

  /**
   * 조기파기 요청 1건.
   * ⚠️ 픽스처 함정 — status 기본값은 PENDING 이고 executedAt 은 nullable 이다. 둘 중 하나라도
   *    빠뜨리면 맵이 비고, "오염되지 않는다"류 음성 단언이 전부 공허하게 통과한다.
   *    그래서 두 값을 항상 명시적으로 받는다.
   */
  const seedRequest = async (
    orderId: number,
    status: EarlyDestroyRequestStatus,
    executedAt: Date | null,
    items: { mappingId: number; deliveryId: number | null }[],
  ): Promise<number> => {
    const request = await requestRepository.save(
      requestRepository.create({
        orderId,
        status,
        requestedBy: customerId,
        requestedAt: new Date(),
        executedBy: executedAt ? customerId : null,
        executedAt,
      } as any) as unknown as EarlyDestroyRequestEntity,
    );
    for (const item of items) {
      await itemRepository.save(
        // FK 컬럼명은 requestId 가 아니라 earlyDestroyRequestId 다
        // (early.destroy.request.item.entity.ts:14). 틀리면 조용히 NULL 로 저장돼
        // relations: ['items'] 가 빈 배열을 돌려주고, 모든 단언이 undefined 로 깨진다.
        itemRepository.create({
          earlyDestroyRequestId: request.id,
          orderProductMappingId: item.mappingId,
          orderDeliveryId: item.deliveryId,
        } as any) as unknown as EarlyDestroyRequestItemEntity,
      );
    }

    // ★ 픽스처 생존 증명 — item 이 실제로 연결됐는지 여기서 못 박는다.
    //   위 FK 오타 같은 실수가 나면 양성 단언은 깨지지만 **음성 단언(map.size === 0 류)은
    //   오히려 통과**해 테스트가 조용히 무의미해진다. 모든 케이스가 이 검사를 공유하게 둔다.
    const saved = await requestRepository.findOne({ where: { id: request.id }, relations: ['items'] });
    expect(saved?.items).toHaveLength(items.length);

    return request.id;
  };

  it('orderDeliveryId 지정 item 은 그 1건만 찍고 형제 발송건은 건드리지 않는다', async () => {
    const { orderId, mappingId } = await seedOrder();
    // 두 건 모두 실행 시각보다 먼저 생성해 둔다 — sibling 에 과거 createdAt 을 주지 않으면
    // 시간축 가드가 대신 걸러내어, 아래 미오염 단언이 "단건 분기가 정확한가"를 증명하지 못한다.
    const sent = new Date('2026-01-01T10:00:00');
    const target = await seedDelivery(mappingId, { createdAt: sent });
    const sibling = await seedDelivery(mappingId, { createdAt: sent }); // 같은 매핑의 다른 발송건

    await seedRequest(orderId, EarlyDestroyRequestStatus.COMPLETED, new Date('2026-02-01T09:00:00'), [
      { mappingId, deliveryId: target },
    ]);

    const map = await service.loadEarlyDestroyedAtMap([orderId]);

    expect(ymd(map.get(target))).toBe('2026-02-01');
    // 양성 대조군 — 형제가 오염되면 픽스처가 죽은 게 아니라 로직이 틀린 것이다.
    expect(map.has(sibling)).toBe(false);
  });

  it('orderDeliveryId 가 NULL 이면 매핑의 발송건 전체로 펼쳐진다 (soft-delete 행 포함)', async () => {
    const { orderId, mappingId } = await seedOrder();
    // 발송(2026-01-01) → 파기(2026-03-05) 순서를 재현한다.
    const sent = new Date('2026-01-01T10:00:00');
    const d1 = await seedDelivery(mappingId, { createdAt: sent });
    const d2 = await seedDelivery(mappingId, { createdAt: sent });
    const soft = await seedDelivery(mappingId, { createdAt: sent, softDeleted: true });

    // deliveryId: null → DB 에서 NULL 로 저장되어 '매핑 전체' 분기로 들어간다.
    await seedRequest(orderId, EarlyDestroyRequestStatus.COMPLETED, new Date('2026-03-05T10:00:00'), [
      { mappingId, deliveryId: null },
    ]);

    const map = await service.loadEarlyDestroyedAtMap([orderId]);

    expect(ymd(map.get(d1))).toBe('2026-03-05');
    expect(ymd(map.get(d2))).toBe('2026-03-05');
    // 조기파기의 PII UPDATE 는 soft-delete 필터를 타지 않으므로 삭제행도 실제로 파기된다.
    expect(ymd(map.get(soft))).toBe('2026-03-05');
  });

  it('실행 이후에 생긴 발송건은 펼치기에서 제외된다 — 살아있는 PII 에 과거 파기일을 찍지 않는다', async () => {
    // 리뷰 CRITICAL: CS 폐기후재발행이 같은 매핑에 새 행을 만든다. 시간축이 없으면 그 행까지
    // "그때 파기됨"으로 도장이 찍혀, 실제로 살아있던 기간을 숨긴 허위 증명이 된다.
    const { orderId, mappingId } = await seedOrder();
    const executedAt = new Date('2026-03-05T10:00:00');

    // 파기 실행 '전'에 있던 발송건과 '후'에 재발행된 tip 을 시간축으로 명확히 갈라 둔다.
    const before = await seedDelivery(mappingId, { createdAt: new Date('2026-01-01T10:00:00') });
    const afterReissue = await seedDelivery(mappingId, { createdAt: new Date('2026-06-01T10:00:00') });

    await seedRequest(orderId, EarlyDestroyRequestStatus.COMPLETED, executedAt, [{ mappingId, deliveryId: null }]);

    const map = await service.loadEarlyDestroyedAtMap([orderId]);

    expect(map.has(before)).toBe(true); // 실행 시점에 있던 행은 포함
    expect(map.has(afterReissue)).toBe(false); // 이후 생긴 행은 제외
  });

  it('PENDING 요청은 무시된다 — 아직 아무것도 지우지 않았다', async () => {
    const { orderId, mappingId } = await seedOrder();
    const d = await seedDelivery(mappingId);

    // PENDING 인데 executedAt 이 채워진 비정상 데이터를 일부러 넣어, status 필터가 사라지는
    // 회귀를 잡는다. 이 절이 빠지면 살아있는 발송건에 파기일이 찍힌다.
    await seedRequest(orderId, EarlyDestroyRequestStatus.PENDING, new Date('2026-02-01T09:00:00'), [
      { mappingId, deliveryId: d },
    ]);

    const map = await service.loadEarlyDestroyedAtMap([orderId]);

    expect(map.size).toBe(0);
  });

  it('COMPLETED 인데 executedAt 이 NULL 이면 제외하고 에러 로그를 남긴다', async () => {
    const { orderId, mappingId } = await seedOrder();
    const d = await seedDelivery(mappingId);

    await seedRequest(orderId, EarlyDestroyRequestStatus.COMPLETED, null, [{ mappingId, deliveryId: d }]);

    const map = await service.loadEarlyDestroyedAtMap([orderId]);

    expect(map.has(d)).toBe(false);
    // 조용히 넘어가면 이 건이 예정일(미래)로 인쇄되므로 흔적이 반드시 남아야 한다.
    // 메시지까지 확인한다 — 인자 매처가 없으면 다른 경로의 error 가 이 단언을 대신 만족시킨다.
    expect(service.logger.error).toHaveBeenCalledWith(expect.stringContaining('executedAt 이 NULL'));
  });

  // 순서를 양방향으로 돌린다. 한쪽만 검사하면 "무조건 덮어쓰기"로 바꿔도 마지막에 처리된 값이
  // 우연히 정답이 되어 변이가 살아남는다(조회 순서는 MySQL 이 보장하지도 않는다).
  it.each([
    ['늦은 요청을 먼저 심은 경우', '2026-05-01T09:00:00', '2026-02-01T09:00:00'],
    ['이른 요청을 먼저 심은 경우', '2026-02-01T09:00:00', '2026-05-01T09:00:00'],
  ])('같은 발송건이 두 COMPLETED 요청에 걸리면 가장 이른 실행 시각이 남는다 — %s', async (_label, first, second) => {
    const { orderId, mappingId } = await seedOrder();
    const d = await seedDelivery(mappingId);

    await seedRequest(orderId, EarlyDestroyRequestStatus.COMPLETED, new Date(first), [{ mappingId, deliveryId: d }]);
    await seedRequest(orderId, EarlyDestroyRequestStatus.COMPLETED, new Date(second), [{ mappingId, deliveryId: d }]);

    const map = await service.loadEarlyDestroyedAtMap([orderId]);

    // 최초 파기가 그 PII 가 사라진 시점이다 — 심은 순서와 무관하게 같은 답이어야 한다.
    expect(ymd(map.get(d))).toBe('2026-02-01');
  });

  it('매핑 전체 기록인데 그 매핑에 발송건이 0건이면 고아로 판정해 에러 로그를 남긴다', async () => {
    const { orderId, mappingId } = await seedOrder(); // 발송건을 만들지 않는다

    await seedRequest(orderId, EarlyDestroyRequestStatus.COMPLETED, new Date('2026-02-01T09:00:00'), [
      { mappingId, deliveryId: null },
    ]);

    const map = await service.loadEarlyDestroyedAtMap([orderId]);

    expect(map.size).toBe(0);
    expect(service.logger.error).toHaveBeenCalledWith(expect.stringContaining('발송건이 0건'));
  });

  it('시간축으로 전량 제외된 매핑은 고아가 아니다 — 정상 동작이므로 error 가 아니라 log 다', async () => {
    // 고아 판정이 시간축 제외와 섞이면, 정상적으로 걸러진 건을 "FK 고아"로 오진해
    // 존재하지 않는 데이터 손상을 쫓게 된다. 두 경로가 분리돼 있음을 고정한다.
    const { orderId, mappingId } = await seedOrder();
    await seedDelivery(mappingId, { createdAt: new Date('2026-06-01T10:00:00') }); // 실행 이후 생성

    await seedRequest(orderId, EarlyDestroyRequestStatus.COMPLETED, new Date('2026-03-05T10:00:00'), [
      { mappingId, deliveryId: null },
    ]);

    const map = await service.loadEarlyDestroyedAtMap([orderId]);

    expect(map.size).toBe(0);
    expect(service.logger.error).not.toHaveBeenCalled(); // 고아 오진 금지
    expect(service.logger.log).toHaveBeenCalledWith(expect.stringContaining('실행 이후 생성된'));
  });

  it('통합 보고서: 여러 주문을 한 번에 처리해도 서로 오염되지 않고 각 주문의 실적이 모두 반영된다', async () => {
    const a = await seedOrder();
    const b = await seedOrder();
    const da = await seedDelivery(a.mappingId);
    const db = await seedDelivery(b.mappingId);
    const untouched = await seedDelivery(b.mappingId);

    await seedRequest(a.orderId, EarlyDestroyRequestStatus.COMPLETED, new Date('2026-02-01T09:00:00'), [
      { mappingId: a.mappingId, deliveryId: da },
    ]);
    await seedRequest(b.orderId, EarlyDestroyRequestStatus.COMPLETED, new Date('2026-04-10T09:00:00'), [
      { mappingId: b.mappingId, deliveryId: db },
    ]);

    const map = await service.loadEarlyDestroyedAtMap([a.orderId, b.orderId]);

    expect(ymd(map.get(da))).toBe('2026-02-01');
    expect(ymd(map.get(db))).toBe('2026-04-10'); // N개 중 1개만 반영되는 회귀를 잡는다
    expect(map.has(untouched)).toBe(false);
  });

  it('주문 id 가 없으면 빈 맵을 돌려준다', async () => {
    const map = await service.loadEarlyDestroyedAtMap([]);
    expect(map.size).toBe(0);
  });
});
