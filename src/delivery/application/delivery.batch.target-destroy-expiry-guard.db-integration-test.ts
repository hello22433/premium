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
import { OrderHistoryEntity } from '../../entity/order.history.entity';
import { DeliveryBatchService } from './delivery.batch.service';

dotenv.config();
jest.setTimeout(120_000);

const TEST_DB_NAME_PATTERN = /test/i;

/**
 * 정기 개인정보파기 배치의 **유효기간 가드**를 실DB(MySQL)로 검증한다.
 *
 * 왜 통합테스트가 따로 필요한가 —
 *   유닛 spec(delivery.batch.target-destroy.spec.ts)은 mock QueryBuilder 에 넘어간 SQL '문자열'만
 *   검사한다. getMany 가 mockResolvedValue 로 고정 배열을 돌려주므로 "그 SQL 이 실제로 그 행을
 *   걸러내는가"는 원리적으로 검증할 수 없다. 특히 아래 둘은 문자열 검사로 절대 잡히지 않는다:
 *     · NULL 3값 논리 — `NULL < DATE(:now)` 가 거짓이 아니라 UNKNOWN 이라 행이 통째로 탈락하는 것
 *     · DATE() 절삭의 자정 경계 — expireAt 의 시분초가 살아 있을 때 어느 회차에서 파기되는지
 *   이 파일은 그 두 축을 실제 MySQL 로 확인한다.
 *
 * 실행 방법 (⚠ dropSchema: true — 스키마를 통째로 지우므로 전용 test DB 에서만 돌린다):
 *   PowerShell:  $env:DATABASE_DATABASE='epopkon_test'; npm run test:db
 *   bash:        DATABASE_DATABASE=epopkon_test npm run test:db
 *
 *   .env 기본값은 DATABASE_DATABASE=epopkon 이라 이름에 'test' 가 없어 아래 가드에 막힌다.
 *   이는 운영/개발 DB 오폭을 막기 위한 기존 관례이며(claim-exclusion 테스트와 동일), 위처럼
 *   환경변수를 덮어써서 실행해야 한다. dotenv 는 이미 설정된 환경변수를 덮어쓰지 않는다.
 *   CI 자동 실행은 없다(.github/workflows 부재) — 가드 로직을 수정하면 수동으로 돌릴 것.
 *
 * timezone: '+09:00' 은 database.module 과 동일하게 맞춘다. DATE() 가 KST 날짜로 절삭된다는
 * 전제(서비스 코드 주석)가 성립해야 경계 케이스 검증이 의미를 갖는다.
 */
describe('DeliveryBatchService.deliveryDeliveryTargetDestroy 유효기간 가드 (실DB)', () => {
  let dataSource: DataSource;
  let deliveryRepository: Repository<OrderDeliveryEntity>;
  let service: any;

  // 시드 공통 부모 레코드
  let productId: number;
  let customerId: number;

  const DESTROY_VALUE = '-';
  const DESTROY_DAY = 180;
  const ORIGINAL_TARGET = '01011112222';

  /** 오늘 00:00(KST 로컬) 기준으로 days 만큼 이동한 Date. 시분초를 명시 지정할 수 있다. */
  const dayAt = (days: number, hours = 12, minutes = 0): Date => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(hours, minutes, 0, 0);
    return d;
  };

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

    service = Object.create(DeliveryBatchService.prototype);
    // §9 컷오버 게이트 — legacy 경로 그대로 통과시킨다(파기 배치는 게이트를 타지 않지만 형식 통일).
    service.cutoverGuard = {
      assertLegacyAllowed: jest.fn().mockResolvedValue(undefined),
      assertRefundExecutionAllowed: jest.fn().mockResolvedValue(undefined),
      isCutover: jest.fn().mockResolvedValue(false),
      splitLegacyAllowed: jest.fn(async (ids: number[]) => ({ allowed: ids, blocked: [] })),
    };
    service.orderDeliveryRepository = deliveryRepository;
    service.orderHistoryRepository = dataSource.getRepository(OrderHistoryEntity);

    // ── 공통 부모 레코드(고객사/협력사/브랜드/상품) 1세트 ──
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
        expireDay: 1826, // 유효기간 5년 상품 — 이 결함의 무대
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

  afterAll(async () => {
    deleteDataSourceByName('default');
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  /**
   * 파기 후보 1건을 심는다. 기본값은 "파기 기준일이 이미 지난" 상태다
   * (sendRequestAt = 200일 전, requestToDestroyPersonalInfoDay = 180).
   *
   * ⚠ requestToDestroyPersonalInfoDay 를 반드시 명시할 것. 이 컬럼은 nullable 인데 NULL 이면
   *   `DATE_ADD(..., INTERVAL NULL DAY)` 가 NULL 이 되어 주 날짜 절에서 행이 통째로 탈락한다.
   *   그러면 "보류되었다" 는 단언이 전부 공허하게 통과(vacuous pass)해 테스트가 무용지물이 된다.
   *   그 사고를 막기 위해 매 테스트에 반드시 파기되어야 하는 positive control 행을 함께 넣는다.
   */
  let seq = 0;
  const seedDelivery = async (opts: {
    label: string;
    expireAt: Date | null;
    couponStatus?: string;
    softDeleted?: boolean;
    sendRequestAt?: Date;
  }): Promise<number> => {
    seq += 1;
    const sendRequestAt = opts.sendRequestAt ?? dayAt(-200);

    const orderRepo = dataSource.getRepository(OrderEntity);
    const mappingRepo = dataSource.getRepository(OrderProductMappingEntity);

    const order = await orderRepo.save(
      orderRepo.create({
        userId: customerId,
        code: `order-${opts.label}-${seq}-${Date.now()}`,
        status: 'DELIVERY_COMPLETE', // 파기 대상 조건
        type: 'GENERAL',
        eventName: '테스트 이벤트',
        registerAt: sendRequestAt,
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
        sendRequestAt,
        requestToDestroyPersonalInfoDay: DESTROY_DAY, // ★ NULL 이면 전체가 vacuous pass
      } as any) as unknown as OrderProductMappingEntity,
    );
    const delivery = await deliveryRepository.save(
      deliveryRepository.create({
        status: 'COMPLETE',
        orderProductMappingId: mapping.id,
        deliveryMethod: 'ALIM_TALK',
        deliveryTarget: ORIGINAL_TARGET,
        sendRequestAt,
        expireAt: opts.expireAt,
        couponStatus: opts.couponStatus ?? 'NOT_USED',
        refundStatus: null,
      } as any) as unknown as OrderDeliveryEntity,
    );

    if (opts.softDeleted) {
      await deliveryRepository.softDelete(delivery.id);
    }
    return delivery.id;
  };

  /** soft-delete 된 행도 읽어야 하므로 withDeleted 로 조회한다. */
  const readTarget = async (id: number): Promise<string | null> => {
    const row = await deliveryRepository.findOne({ where: { id }, withDeleted: true });
    return row?.deliveryTarget ?? null;
  };

  it('미사용 + 유효기간 남음만 보류하고, 나머지는 종전대로 파기한다', async () => {
    // positive control — 반드시 파기되어야 하는 행. 이게 파기되지 않으면 픽스처가 주 날짜 절을
    // 통과하지 못한 것이므로, 아래 '보류' 단언들은 전부 의미가 없다(테스트 자체가 거짓 초록).
    const controlId = await seedDelivery({ label: 'control-expired', expireAt: dayAt(-1) });

    const holdId = await seedDelivery({ label: 'hold-future', expireAt: dayAt(+1) });
    const nullExpireId = await seedDelivery({ label: 'null-expire', expireAt: null });
    const softDeletedId = await seedDelivery({ label: 'soft-deleted', expireAt: dayAt(+1), softDeleted: true });
    const usedId = await seedDelivery({ label: 'used', expireAt: dayAt(+1), couponStatus: 'USED' });
    const cancelId = await seedDelivery({ label: 'cancel', expireAt: dayAt(+1), couponStatus: 'CANCEL' });

    await service.deliveryDeliveryTargetDestroy();

    // ① positive control — 픽스처가 유효함을 먼저 증명한다
    expect(await readTarget(controlId)).toBe(DESTROY_VALUE);

    // ② 이 PR 의 존재 이유 — 미사용 + 유효기간 남음은 수신처가 보존된다
    expect(await readTarget(holdId)).toBe(ORIGINAL_TARGET);

    // ③ 유효기간이 없는 건은 종전대로 파기. 절 1(expireAt IS NULL)이 없으면 NULL 3값 논리로
    //    영구 미파기가 되는 집합이라, 이 단언이 그 회귀를 막는 핵심이다.
    expect(await readTarget(nullExpireId)).toBe(DESTROY_VALUE);

    // ④ soft-delete 된 tip — withDeleted() 로 후보에 들어오고, update 는 soft-delete 필터를
    //    타지 않으므로 실제로 마스킹된다.
    expect(await readTarget(softDeletedId)).toBe(DESTROY_VALUE);

    // ⑤⑥ 이미 소멸한 쿠폰은 유효기간이 남아 있어도 파기
    expect(await readTarget(usedId)).toBe(DESTROY_VALUE);
    expect(await readTarget(cancelId)).toBe(DESTROY_VALUE);
  });

  it('만료 당일은 보류하고 다음 날 회차에서 파기한다 — DATE() 절삭의 자정 경계', async () => {
    // expireAt 은 addDays(발송시각, N) 이라 시분초가 살아 있다. 크론은 자정에 돈다.
    // 오늘 00:30 만료 → DATE(오늘) < DATE(오늘) 이 거짓 → 보류 (만료 당일은 아직 유효)
    const todayEarlyId = await seedDelivery({ label: 'today-0030', expireAt: dayAt(0, 0, 30) });
    // 오늘 23:30 만료 → 같은 날짜라 역시 보류. 시각이 아니라 날짜로 절삭됨을 확인한다.
    const todayLateId = await seedDelivery({ label: 'today-2330', expireAt: dayAt(0, 23, 30) });
    // 어제 23:30 만료 → DATE(어제) < DATE(오늘) 참 → 파기. 하루 차이로 결과가 갈린다.
    const yesterdayLateId = await seedDelivery({ label: 'yesterday-2330', expireAt: dayAt(-1, 23, 30) });

    await service.deliveryDeliveryTargetDestroy();

    expect(await readTarget(todayEarlyId)).toBe(ORIGINAL_TARGET);
    expect(await readTarget(todayLateId)).toBe(ORIGINAL_TARGET);
    expect(await readTarget(yesterdayLateId)).toBe(DESTROY_VALUE);
  });

  it('보류된 행은 유효기간이 지나면 다음 회차에서 자동으로 파기된다 (재포착)', async () => {
    // 만료 하루 뒤 상태를 흉내내기 위해, 먼저 미래 만료로 보류시킨 뒤 expireAt 을 과거로 당긴다.
    const id = await seedDelivery({ label: 'reclaim', expireAt: dayAt(+1) });

    await service.deliveryDeliveryTargetDestroy();
    expect(await readTarget(id)).toBe(ORIGINAL_TARGET); // 1회차: 보류

    await deliveryRepository.update(id, { expireAt: dayAt(-1) });

    await service.deliveryDeliveryTargetDestroy();
    expect(await readTarget(id)).toBe(DESTROY_VALUE); // 2회차: 자동 파기 — 누락 없음
  });

  it('couponStatus 는 NOT NULL 이라 legacy NULL 로 새는 행이 존재하지 않는다', async () => {
    // 서비스 주석이 "NULL 이면 파기 보류 쪽으로 떨어진다(안전 방향)" 라고 서술하는 근거를
    // 스키마 차원에서 고정한다. 이 컬럼이 언젠가 nullable 로 바뀌면 이 테스트가 먼저 깨져
    // 가드의 NULL 거동을 재검토하게 만든다.
    const column = await dataSource.query(
      `SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_delivery' AND COLUMN_NAME = 'coupon_status'`,
    );
    expect(column[0].IS_NULLABLE).toBe('NO');
  });
});
