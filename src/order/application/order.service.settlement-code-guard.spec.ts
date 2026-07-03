import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';
import { OrderService } from './order.service';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';
import { SettlementCodeRequiredError } from '../../wallet/application/settlement-code-required.error';

/**
 * PR-B — deliveryRequest(발송요청) settlement_code 가드.
 *
 * WALLET 흐름(order.isNewBillingFlow=true) + 과금 user settlement_code 비어있음 +
 * SETTLEMENT_CODE_GUARD_ENFORCE 활성화 → SettlementCodeRequiredError.
 * 그 외 조합(비활성/legacy/코드존재)은 이 가드로 차단되지 않는다 (기본 OFF, DARK).
 */
describe('OrderService deliveryRequest — settlement_code guard (PR-B)', () => {
  beforeAll(() => {
    initializeTransactionalContext();
    deleteDataSourceByName('default');
    addTransactionalDataSource({
      name: 'default',
      patch: false,
      dataSource: {
        transaction: async (...args: any[]) => {
          const callback = typeof args[0] === 'function' ? args[0] : args[1];
          return callback({});
        },
      } as any,
    });
  });

  afterAll(() => {
    deleteDataSourceByName('default');
  });

  const createQueryBuilder = (result: unknown) => ({
    setLock: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(result),
    getOneOrFail: jest.fn().mockResolvedValue(result),
    getMany: jest.fn().mockResolvedValue(result),
  });

  const createService = (opts: { isNewBillingFlow: boolean; settlementCode: string | null; flagEnabled: boolean }) => {
    const order = {
      id: 700,
      userId: 10,
      clientUserId: null,
      eventName: 'guard-test',
      type: IOrderType.GENERAL,
      status: IOrderStatus.TEMP,
      isNewBillingFlow: opts.isNewBillingFlow,
      orderProductMappings: [
        {
          id: 71,
          amount: 1,
          sendType: 'IMMEDIATE',
          sendTitle: 'title',
          sendContent: 'content',
          product: { price: 10000, useStatus: 'USE' },
          orderDeliveries: [{ id: 91 }],
        },
      ],
    } as any;

    // PERSONAL 모드 과금 user (lockBillingScope: companyId null → personal path)
    const billingUser = {
      id: 10,
      companyId: null,
      company: null,
      balance: 1_000_000,
      allSettleAmount: 0,
      settlementCode: opts.settlementCode,
    };

    const orderQueryBuilder = createQueryBuilder(order);
    const billingUserQueryBuilder = createQueryBuilder(billingUser);

    const service = Object.create(OrderService.prototype) as any;
    service.orderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(orderQueryBuilder),
      save: jest.fn().mockResolvedValue(undefined),
    };
    service.userRepository = {
      findOne: jest.fn().mockResolvedValue(billingUser),
      createQueryBuilder: jest.fn().mockReturnValue(billingUserQueryBuilder),
      save: jest.fn().mockResolvedValue(undefined),
    };
    service.userCompanyRepository = { save: jest.fn().mockResolvedValue(undefined) };
    service.orderDeliveryRepository = { save: jest.fn().mockResolvedValue(undefined) };
    service.forbiddenWordMatcher = { scan: jest.fn().mockReturnValue([]) };
    service.walletCutoverConfig = { settlementCodeGuardEnforced: opts.flagEnabled };
    service.logger = { log: jest.fn(), debug: jest.fn() };
    // PR-A 통합 대비: deliveryRequest 는 BillingScopeLockService.lock 로 과금 범위를 잠근다.
    // wip5 단독에서는 미사용(inert)이나, PR-A(wip4) 통합 후 order.service 가 이 의존성을 호출한다 (MED-3).
    service.billingScopeLockService = {
      lock: jest.fn().mockResolvedValue({ user: billingUser, companyUsers: [billingUser] }),
    };

    return { service, order, billingUser };
  };

  const run = (service: any, order: any) => service.deliveryRequest({ id: order.userId } as any, { id: order.id });

  it('(a) flag ON + WALLET flow + empty code → SettlementCodeRequiredError (body code)', async () => {
    const { service, order } = createService({ isNewBillingFlow: true, settlementCode: '', flagEnabled: true });

    await expect(run(service, order)).rejects.toBeInstanceOf(SettlementCodeRequiredError);

    const err = await run(service, order).catch((e: any) => e);
    expect(err.getResponse()).toMatchObject({ code: 'SETTLEMENT_CODE_REQUIRED' });
  });

  it('(a2) flag ON + WALLET flow + null code → SettlementCodeRequiredError', async () => {
    const { service, order } = createService({ isNewBillingFlow: true, settlementCode: null, flagEnabled: true });

    await expect(run(service, order)).rejects.toBeInstanceOf(SettlementCodeRequiredError);
  });

  it('(b) flag ON + WALLET flow + non-empty code → 가드 통과 (no throw)', async () => {
    const { service, order } = createService({
      isNewBillingFlow: true,
      settlementCode: 'company-10',
      flagEnabled: true,
    });

    await expect(run(service, order)).resolves.toBeUndefined();
    expect(order.status).toBe(IOrderStatus.DELIVERY_REQUEST);
  });

  it('(c) flag ON + legacy flow + empty code → 이 가드로 차단되지 않음', async () => {
    const { service, order } = createService({ isNewBillingFlow: false, settlementCode: '', flagEnabled: true });

    await expect(run(service, order)).resolves.toBeUndefined();
    expect(order.status).toBe(IOrderStatus.DELIVERY_REQUEST);
  });

  it('(d) flag OFF + WALLET flow + empty code → 차단되지 않음 (DARK 기본값)', async () => {
    const { service, order } = createService({ isNewBillingFlow: true, settlementCode: '', flagEnabled: false });

    await expect(run(service, order)).resolves.toBeUndefined();
    expect(order.status).toBe(IOrderStatus.DELIVERY_REQUEST);
  });
});
