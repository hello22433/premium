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
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { OrderService } from './order.service';

dotenv.config();
jest.setTimeout(180_000);

const TEST_DB_NAME_PATTERN = /test/i;

/**
 * 부분취소의 **CAS 와 롤백 계약을 실 DB 로** 검증한다 (197-16 리뷰 MEDIUM 4).
 *
 * 단위 스펙(order.service.partial-cancel / cancel-cas)은 쿼리빌더를 목으로 받기 때문에
 * SQL 이 실제로 무엇을 걸러내는지 알 수 없다 — cancel-cas 스펙은 스스로 밝히듯 EXISTS 서브쿼리를
 * **문자열 동일성**으로만 검사해, 의미가 뒤집힌 서브쿼리로 바꿔도 문자열만 맞으면 통과한다.
 * 또 모든 단위 스펙이 첫 줄에서 Transactional 을 무력화하므로 "throw = 롤백" 이라는 이 경로의
 * 핵심 계약(409 = 아무것도 취소·환불되지 않았다)을 검증하는 테스트가 하나도 없었다.
 *
 * 여기서 지키는 것:
 *  1) EXISTS(order_id) 실효 — 타 주문 발송건 id 를 섞으면 갱신되지 않는다 (IDOR + 자금 결함 방어)
 *  2) deleted_at IS NULL 실효 — soft-delete 된 행은 갱신되지 않는다
 *  3) 배치 선점(claimed_at) 실효 — 경합 시 던지고 그 행은 그대로다
 *  4) **롤백 실효** — 환불 커버리지 실패로 던지면 이미 쓴 CANCEL 이 DB 에 남지 않는다
 *
 * 4번이 "409 = 아무것도 안 됐다" 를 실제로 지키는 유일한 테스트다.
 * 실행: npm run test:db (DATABASE_DATABASE 이름에 test 가 포함돼야 한다)
 */
describe('OrderService 부분취소 — CAS / 롤백 (실 DB)', () => {
  let dataSource: DataSource;
  let deliveryRepository: Repository<OrderDeliveryEntity>;
  let service: any;

  // 시드 1벌(고객/협력사/브랜드/상품)을 만들어 케이스마다 주문만 새로 붙인다.
  let customerId: number;
  let productId: number;
  let productPrice: number;

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
    } as any);
    productId = (product as any).id;
    productPrice = 10_000;
  });

  afterAll(async () => {
    deleteDataSourceByName('default');
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  let orderSeq = 0;

  /** 발송확정 상태의 주문 1건 + 취소 가능한 WAIT 발송건 n건을 만든다. */
  const seedOrder = async (deliveryCount: number, deliveryOverrides: Partial<OrderDeliveryEntity> = {}) => {
    orderSeq += 1;
    // 컷오프(10분)를 넉넉히 넘긴 예약시각 — 취소 가능 조건을 만족시킨다.
    const sendRequestAt = new Date(Date.now() + 60 * 60 * 1000);

    const order = await dataSource.getRepository(OrderEntity).save({
      userId: customerId,
      code: `order-pc-${Date.now()}-${orderSeq}`,
      status: 'DELIVERY_CONFIRMED',
      type: 'GENERAL',
      eventName: '부분취소 통합테스트',
      registerAt: new Date(),
      sendAmount: productPrice * deliveryCount,
      settleAmount: productPrice * deliveryCount,
      isNewBillingFlow: true,
      cardSurchargeApplied: false,
    } as any);
    const mapping = await dataSource.getRepository(OrderProductMappingEntity).save({
      orderId: (order as any).id,
      productId,
      amount: deliveryCount,
      topImagePath: '',
      midImagePath: '',
      sendRequestAt,
      snapshotProductPrice: productPrice,
    } as any);

    const deliveries: OrderDeliveryEntity[] = [];
    for (let i = 0; i < deliveryCount; i += 1) {
      const delivery = await deliveryRepository.save({
        orderProductMappingId: (mapping as any).id,
        status: 'WAIT',
        deliveryMethod: 'MMS',
        deliveryTarget: `0100000${String(i).padStart(4, '0')}`,
        couponStatus: 'NOT_USED',
        sendRequestAt,
        actualSendAt: null,
        claimedAt: null,
        couponIssuedAt: null,
        barCode: null,
        reportState: null,
        ...deliveryOverrides,
      } as any);
      deliveries.push(delivery as unknown as OrderDeliveryEntity);
    }
    return { orderId: (order as any).id as number, deliveries };
  };

  const readStatuses = async (ids: number[]) => {
    const rows = await deliveryRepository
      .createQueryBuilder('od')
      .select(['od.id', 'od.status', 'od.canceledAt'])
      .where('od.id IN (:...ids)', { ids })
      .withDeleted()
      .getMany();
    return new Map(rows.map((row) => [Number(row.id), row.status as string]));
  };

  // ── 1) CAS: EXISTS(order_id) ────────────────────────────────────────────────
  // deliveryIds 는 요청 바디에서 온 값이다. id IN (...) 만으로 갱신하면 남의 주문 발송건이
  // 취소되고 환불은 요청자 주문 기준으로 일어난다(IDOR + 자금 결함).
  it('타 주문의 발송건 id 를 섞으면 갱신되지 않고 던진다 (EXISTS order_id 실효)', async () => {
    const mine = await seedOrder(1);
    const others = await seedOrder(1);
    const svc: any = Object.create(OrderService.prototype);
    svc.orderDeliveryRepository = deliveryRepository;
    svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const ids = [Number(mine.deliveries[0].id), Number(others.deliveries[0].id)];

    await expect(svc.cancelDeliveriesIfStillWaiting(mine.orderId, ids, '사유', new Date())).rejects.toBeInstanceOf(
      ConflictException,
    );

    // 내 주문 건은 갱신됐을 수 있으나(같은 문장), 타 주문 건은 절대 CANCEL 이 되면 안 된다.
    const statuses = await readStatuses(ids);
    expect(statuses.get(Number(others.deliveries[0].id))).toBe('WAIT');
  });

  // ── 2) CAS: deleted_at IS NULL ──────────────────────────────────────────────
  // UpdateQueryBuilder 는 soft-delete 필터를 자동 적용하지 않는다(SelectQueryBuilder 와 다름).
  // 조건이 빠지면 이미 삭제된 행을 되살려 취소·환불 대상으로 만든다.
  it('soft-delete 된 발송건은 갱신되지 않고 던진다 (deleted_at IS NULL 실효)', async () => {
    const { orderId, deliveries } = await seedOrder(1);
    const id = Number(deliveries[0].id);
    await deliveryRepository.softDelete(id);

    const svc: any = Object.create(OrderService.prototype);
    svc.orderDeliveryRepository = deliveryRepository;
    svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    await expect(svc.cancelDeliveriesIfStillWaiting(orderId, [id], '사유', new Date())).rejects.toBeInstanceOf(
      ConflictException,
    );

    const statuses = await readStatuses([id]);
    expect(statuses.get(id)).toBe('WAIT');
  });

  // ── 3) CAS: 배치 선점 ────────────────────────────────────────────────────────
  // 발송 배치(claimWaitDeliveries)가 같은 행을 먼저 집으면 claimed_at 이 찬다.
  // 같은 행에 대한 UPDATE 라 DB 가 직렬화하고, 조건 불일치로 affected 가 줄어 던져야 한다.
  it('배치가 먼저 claim 한 건은 갱신되지 않고 던진다 (claimed_at 실효)', async () => {
    const { orderId, deliveries } = await seedOrder(1, { claimedAt: new Date() } as any);
    const id = Number(deliveries[0].id);

    const svc: any = Object.create(OrderService.prototype);
    svc.orderDeliveryRepository = deliveryRepository;
    svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    await expect(svc.cancelDeliveriesIfStillWaiting(orderId, [id], '사유', new Date())).rejects.toBeInstanceOf(
      ConflictException,
    );

    const statuses = await readStatuses([id]);
    expect(statuses.get(id)).toBe('WAIT');
  });

  // ── 4) 롤백: "409 = 아무것도 취소·환불되지 않았다" ───────────────────────────
  // 이 경로는 CANCEL 을 먼저 쓰고(CAS) 그 다음 환불한다. 환불 커버리지 검증이 실패해 던질 때
  // 이미 쓴 CANCEL 이 남아 있으면 "취소는 됐는데 환불은 안 된" 주문이 생긴다.
  // 단위 스펙은 Transactional 을 무력화하므로 이 계약을 확인할 수 없다 — 실 DB 로 확인한다.
  it('환불 커버리지 실패로 던지면 이미 쓴 CANCEL 이 롤백된다 (409 = 아무것도 안 됨)', async () => {
    const { orderId, deliveries } = await seedOrder(2);
    const ids = deliveries.map((delivery) => Number(delivery.id)).sort((a, b) => a - b);

    // allocation 이 있어야 부분취소가 진행된다(없으면 미지원 주문으로 400).
    await dataSource.getRepository(OrderPaymentAllocationEntity).save({
      orderId,
      walletAccountId: '1',
      grossSettlementAmount: productPrice * 2,
      payableSettlementAmount: productPrice * 2,
      depositUsedAmount: productPrice * 2,
    } as any);

    const svc: any = Object.create(OrderService.prototype);
    svc.orderRepository = dataSource.getRepository(OrderEntity);
    svc.orderDeliveryRepository = deliveryRepository;
    svc.orderProductMappingRepository = dataSource.getRepository(OrderProductMappingEntity);
    svc.userRepository = dataSource.getRepository(UserEntity);
    svc.userCompanyRepository = dataSource.getRepository(PartnerCompanyEntity);
    svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    svc.walletManagedPredicate = { isWalletManaged: async () => true };
    // 과금 범위 잠금 — 발송확정과 락 순서를 맞추려고 환불 전에 호출한다(교착 차단).
    // 이 테스트의 관심사는 롤백이라 실제 잠금은 필요 없다.
    svc.billingScopeLockService = { lock: async () => ({ user: {}, companyUsers: [] }) };
    svc.orderCancelNotificationService = {
      notifyDirectOrderCancel: jest.fn(),
      notifyDirectOrderPartialCancel: jest.fn(),
    };
    svc.orderConfirmationReleaseService = { releaseConfirmation: jest.fn() };
    // ★ 원장을 요청보다 적게 돌려준다 = 일부 발송건에 정산 라인이 없어 미환불된 상황.
    //   프로덕션은 여기서 커버리지 검증에 걸려 던진다.
    svc.refundPoolService = {
      refund: async () => ({ alreadyRefunded: false, ledgerIds: ['only-one'], totalRefundedAmount: 1 }),
    };

    // ★ 메시지까지 특정한다. CAS 경합도 같은 ConflictException 이라, 타입만 보면 "CAS 단계에서
    //   던져 애초에 아무것도 쓰지 않은" 경우에도 통과해버린다 — 그러면 롤백을 검증하지 못한다.
    //   이 메시지는 CAS 를 통과해 **CANCEL 을 이미 쓴 뒤** 환불 커버리지에서 던졌다는 증거다.
    await expect(svc.partialDeliveryCancel(orderId, ids, '사유')).rejects.toThrow(/환불 정보를 찾지 못한/);

    // 핵심: 던졌으면 DB 에 CANCEL 이 하나도 남아선 안 된다.
    const statuses = await readStatuses(ids);
    for (const id of ids) {
      expect(statuses.get(id)).toBe('WAIT');
    }
  });
});
