import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';
import { ExternalApiService } from './external.api.service';
import { ExternalApiException } from '../api/external.api.exception.filter';

// @Transactional() 데코레이터가 phaseA 메서드를 감싸므로 storage driver + 더미 data source 필요.
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
import { CreditExcessApprovalRequiredError } from '../../wallet/application/credit-excess-approval-required.error';
import { WalletCutoverMode } from '../../wallet/config/wallet-cutover.config';
import { ExternalApiAccountEntity } from '../../entity/external.api.account.entity';
import { OrderEntity } from '../../entity/order.entity';
import { AllocationResult } from '../../wallet/application/payment-allocation.service';

// External API WALLET 차감 경로 단위 테스트.
// deductViaWallet (allocate→persistAllocation→legacy mirror, fail-closed, excess 변환) +
// 두 phaseA 의 WALLET/LEGACY 분기 라우팅을 검증한다.

type Mode = WalletCutoverMode;

function makeAllocation(over: Partial<AllocationResult>): AllocationResult {
  return {
    orderId: 1,
    walletAccountId: 'w-1',
    grossSettlementAmount: 0,
    pointUsedAmount: 0,
    cardSurchargeBase: 0,
    cardSurchargeAmount: 0,
    payableSettlementAmount: 0,
    depositUsedAmount: 0,
    creditUsedAmount: 0,
    creditExcessAmount: 0,
    cardSurchargeApplied: false,
    hasDiscount: false,
    lines: [{ orderDeliveryId: 55 } as any],
    pointUsages: [],
    resourceBreakdown: {} as any,
    ...over,
  };
}

function makeService(opts: {
  mode: Mode;
  resolveByUserId?: jest.Mock;
  allocation?: AllocationResult;
  persistResult?: any;
  persistThrows?: Error;
}) {
  const svc = Object.create(ExternalApiService.prototype) as ExternalApiService;
  (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };

  const queries: Array<{ sql: string; params: any[] }> = [];
  const managerQuery = jest.fn(async (sql: string, params: any[]) => {
    queries.push({ sql, params });
    return { affectedRows: 1 };
  });
  (svc as any).dataSource = { manager: { query: managerQuery } };

  const orderSave = jest.fn(async (o: any) => o);
  (svc as any).orderRepository = { save: orderSave };

  (svc as any).walletCutoverConfig = { pr2DeliveryLifecycleMode: opts.mode };
  (svc as any).walletAccountResolverService = {
    resolveByUserId:
      opts.resolveByUserId ??
      jest.fn(async () => ({
        id: 'w-1',
        depositBalance: 100000,
        creditLimit: 0,
        creditUsedAmount: 0,
        settleCondition: 'PRE_PAYMENT',
      })),
  };
  (svc as any).walletAllocationInputBuilder = {
    build: jest.fn(async () => ({ lines: [], orderId: 1, walletAccountId: 'w-1' })),
  };
  (svc as any).paymentAllocationService = {
    allocate: jest.fn(() => opts.allocation ?? makeAllocation({})),
  };
  const persistAllocation = jest.fn(async () => {
    if (opts.persistThrows) throw opts.persistThrows;
    return opts.persistResult ?? { finalAllocation: opts.allocation ?? makeAllocation({}) };
  });
  (svc as any).orderConfirmationWalletService = { persistAllocation };

  return {
    svc,
    mocks: {
      managerQuery,
      orderSave,
      resolveByUserId: (svc as any).walletAccountResolverService.resolveByUserId,
      build: (svc as any).walletAllocationInputBuilder.build,
      allocate: (svc as any).paymentAllocationService.allocate,
      persistAllocation,
    },
    queries,
  };
}

function makeAccount(over?: { isCompany?: boolean; settleMethod?: string }): ExternalApiAccountEntity {
  const company = over?.isCompany
    ? { id: 9, balanceManagementType: 'COMPANY', settleMethod: over?.settleMethod ?? 'CASH' }
    : undefined;
  return {
    user: {
      id: 42,
      companyId: over?.isCompany ? 9 : null,
      settleMethod: over?.settleMethod ?? 'CASH',
      company,
    },
  } as any;
}

function makeOrder(): OrderEntity {
  return {
    id: 1,
    cardSurchargeApplied: false,
    settleAmount: 0,
    isSettleBalance: true,
    isCreditExcess: false,
  } as any;
}

// PR2a: phaseA_* 가 ctx 인자(ctx.apiApp.id 등)를 요구. billingUserId 는 account.user.id(=42)와 일치시켜 단순모드 동작 보존.
const ctx = {
  apiApp: { id: '1', requireExternalCustomerId: false },
  apiCredential: { id: '1' },
  billingUserId: 42,
  externalCustomerId: null,
} as any;

describe('ExternalApiService wallet 차감 (deductViaWallet)', () => {
  it('선정산 예치금 충분 → allocation 생성 + legacy mirror(company.balance/allSettleAmount), user.balance 불변', async () => {
    const allocation = makeAllocation({
      payableSettlementAmount: 30000,
      depositUsedAmount: 30000,
      creditUsedAmount: 0,
      creditExcessAmount: 0,
    });
    const { svc, mocks, queries } = makeService({
      mode: WalletCutoverMode.WALLET,
      allocation,
      persistResult: { finalAllocation: allocation },
    });
    const account = makeAccount({ isCompany: true });
    const order = makeOrder();

    await (svc as any).deductViaWallet(account.user, order, 30000);

    expect(mocks.resolveByUserId).toHaveBeenCalledWith(42, expect.anything());
    expect(mocks.allocate).toHaveBeenCalledTimes(1);
    expect(mocks.persistAllocation).toHaveBeenCalledTimes(1);

    // legacy mirror
    expect(order.settleAmount).toBe(30000);
    expect(order.isSettleBalance).toBe(true);
    expect(order.isCreditExcess).toBe(false);

    // company.balance -= depositUsedAmount, allSettleAmount += 0
    const companyUpdate = queries.find((q) => q.sql.includes('user_company'));
    expect(companyUpdate).toBeDefined();
    expect(companyUpdate!.params).toEqual([30000, 9]);

    const userUpdate = queries.find((q) => q.sql.includes('UPDATE user SET all_settle_amount'));
    expect(userUpdate).toBeDefined();
    expect(userUpdate!.params).toEqual([0, 42]);

    // user.balance 는 절대 기록하지 않음
    expect(queries.some((q) => /UPDATE user SET balance/.test(q.sql))).toBe(false);
  });

  it('후정산 여신 → creditUsed mirror(allSettleAmount += creditUsed+excess), isSettleBalance=false', async () => {
    const allocation = makeAllocation({
      payableSettlementAmount: 50000,
      depositUsedAmount: 0,
      creditUsedAmount: 50000,
      creditExcessAmount: 0,
    });
    const { svc, queries } = makeService({
      mode: WalletCutoverMode.WALLET,
      allocation,
      persistResult: { finalAllocation: allocation },
    });
    const account = makeAccount({ isCompany: false });
    const order = makeOrder();

    await (svc as any).deductViaWallet(account.user, order, 50000);

    expect(order.isSettleBalance).toBe(false);
    expect(order.isCreditExcess).toBe(false);

    const userUpdate = queries.find((q) => q.sql.includes('UPDATE user SET all_settle_amount'));
    expect(userUpdate!.params).toEqual([50000, 42]);
    // PERSONAL 모드 → user_company 미터치
    expect(queries.some((q) => q.sql.includes('user_company'))).toBe(false);
    expect(queries.some((q) => /UPDATE user SET balance/.test(q.sql))).toBe(false);
  });

  it('선정산 예치금 부족 → persist 가 CreditExcessApprovalRequiredError throw → 3002 변환', async () => {
    const { svc, mocks } = makeService({
      mode: WalletCutoverMode.WALLET,
      persistThrows: new CreditExcessApprovalRequiredError(10000, 1),
    });
    const account = makeAccount();
    const order = makeOrder();

    await expect((svc as any).deductViaWallet(account.user, order, 30000)).rejects.toMatchObject({
      code: '3002',
    });
    // mirror/order save 미발생 (rollback 은 TX 가 보장, 여기선 mirror 쿼리 0)
    expect(mocks.orderSave).not.toHaveBeenCalled();
  });

  it('wallet 없음(resolve 실패) → 3002 fail-closed (legacy fallback 금지)', async () => {
    const { svc, mocks } = makeService({
      mode: WalletCutoverMode.WALLET,
      resolveByUserId: jest.fn(async () => {
        throw new Error('wallet_account not found');
      }),
    });
    const account = makeAccount();
    const order = makeOrder();

    await expect((svc as any).deductViaWallet(account.user, order, 30000)).rejects.toBeInstanceOf(ExternalApiException);
    await expect((svc as any).deductViaWallet(account.user, order, 30000)).rejects.toMatchObject({
      code: '3002',
    });
    expect(mocks.build).not.toHaveBeenCalled();
  });

  const walletWith = (settleMethod: string) =>
    jest.fn(async () => ({
      id: 'w-1',
      depositBalance: 100000,
      creditLimit: 0,
      creditUsedAmount: 0,
      settleCondition: 'PRE_PAYMENT',
      settleMethod,
    }));

  it('settleMethodSnapshot: order.settleMethod 가 있으면 우선 사용한다 (회사/wallet 무시)', async () => {
    const allocation = makeAllocation({ payableSettlementAmount: 0 });
    const { svc, mocks } = makeService({
      mode: WalletCutoverMode.WALLET,
      allocation,
      persistResult: { finalAllocation: allocation },
      resolveByUserId: walletWith('CASH'), // wallet 정책 (무시되어야 함)
    });
    const account = makeAccount({ isCompany: true, settleMethod: 'CASH' });
    await (svc as any).deductViaWallet(account.user, { ...makeOrder(), settleMethod: 'CARD' }, 0);

    const persistArg = (mocks.persistAllocation.mock.calls[0] as any[])[0];
    expect(persistArg.settleMethodSnapshot).toBe('CARD'); // order.settleMethod 우선
  });

  it('settleMethodSnapshot: order.settleMethod 없으면 wallet SoT 로 폴백한다 (company/user 무시)', async () => {
    const allocation = makeAllocation({ payableSettlementAmount: 0 });
    const { svc, mocks } = makeService({
      mode: WalletCutoverMode.WALLET,
      allocation,
      persistResult: { finalAllocation: allocation },
      resolveByUserId: walletWith('CARD'), // wallet SoT
    });
    const account = makeAccount({ isCompany: true, settleMethod: 'CASH' }); // 회사 정책 무시
    await (svc as any).deductViaWallet(account.user, makeOrder(), 0); // order.settleMethod 없음

    const persistArg = (mocks.persistAllocation.mock.calls[0] as any[])[0];
    expect(persistArg.settleMethodSnapshot).toBe('CARD'); // wallet 폴백
    expect(persistArg.creditExcessApprovalId).toBeNull();
    expect(persistArg.deliveryIdsForAttempt).toEqual([55]);
  });
});

describe('ExternalApiService phaseA 분기 라우팅 (WALLET vs LEGACY)', () => {
  function routingService(mode: Mode) {
    const svc = Object.create(ExternalApiService.prototype) as ExternalApiService;
    (svc as any).walletCutoverConfig = { pr2DeliveryLifecycleMode: mode };
    const deductViaWallet = jest.fn(async () => undefined);
    const deductBalance = jest.fn(async () => undefined);
    (svc as any).deductViaWallet = deductViaWallet;
    (svc as any).deductBalance = deductBalance;
    return { svc, deductViaWallet, deductBalance };
  }

  // phaseA 의 분기 조각을 그대로 재현 (회귀 가드용 — branch 로직 동치성 확인).
  async function runBranch(
    svc: ExternalApiService,
    account: any,
    order: any,
    mapping: any,
    orderDelivery: any,
    settleAmount: number,
  ) {
    if ((svc as any).walletCutoverConfig.pr2DeliveryLifecycleMode === WalletCutoverMode.WALLET) {
      mapping.orderDeliveries = [orderDelivery];
      order.orderProductMappings = [mapping];
      await (svc as any).deductViaWallet(account, order, settleAmount);
    } else {
      await (svc as any).deductBalance(account, settleAmount);
    }
  }

  it('WALLET 모드 → deductViaWallet + R6 관계그래프 구성', async () => {
    const { svc, deductViaWallet, deductBalance } = routingService(WalletCutoverMode.WALLET);
    const order: any = {};
    const mapping: any = { product: {} };
    const orderDelivery: any = { id: 7 };
    await runBranch(svc, makeAccount(), order, mapping, orderDelivery, 1000);

    expect(deductViaWallet).toHaveBeenCalledTimes(1);
    expect(deductBalance).not.toHaveBeenCalled();
    expect(mapping.orderDeliveries).toEqual([orderDelivery]);
    expect(order.orderProductMappings).toEqual([mapping]);
  });

  it('LEGACY 모드 → 기존 raw deductBalance (회귀 0)', async () => {
    const { svc, deductViaWallet, deductBalance } = routingService(WalletCutoverMode.LEGACY);
    await runBranch(svc, makeAccount(), {}, { product: {} }, { id: 7 }, 1000);
    expect(deductBalance).toHaveBeenCalledWith(expect.anything(), 1000);
    expect(deductViaWallet).not.toHaveBeenCalled();
  });

  it('SHADOW 모드 → 기존 raw deductBalance (회귀 0)', async () => {
    const { svc, deductViaWallet, deductBalance } = routingService(WalletCutoverMode.SHADOW);
    await runBranch(svc, makeAccount(), {}, { product: {} }, { id: 7 }, 1000);
    expect(deductBalance).toHaveBeenCalledWith(expect.anything(), 1000);
    expect(deductViaWallet).not.toHaveBeenCalled();
  });
});

// ─── phaseA end-to-end (R6 / SSG) — 실제 phaseA 메서드 구동 ───
// 차감 직전까지 phaseA 의 저장 흐름을 mock repo 로 구동하고, deductViaWallet 은
// 실제 본문이 호출되도록 두되 wallet 협력자만 mock — build/allocate/persist 가
// 올바른 관계그래프 + 인자로 호출되는지 확인한다.

function phaseAService(mode: Mode) {
  const svc = Object.create(ExternalApiService.prototype) as ExternalApiService;
  (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };

  let seq = 0;
  const idAssign = (e: any) => {
    if (e.id == null) e.id = ++seq;
    return e;
  };
  (svc as any).orderRepository = {
    create: (v: any) => ({ ...v }),
    save: jest.fn(async (e: any) => idAssign(e)),
    findOne: jest.fn(async () => null),
  };
  (svc as any).orderProductMappingRepository = {
    create: (v: any) => ({ ...v }),
    save: jest.fn(async (e: any) => idAssign(e)),
  };
  (svc as any).orderDeliveryRepository = {
    create: (v: any) => ({ ...v }),
    save: jest.fn(async (e: any) => idAssign(e)),
    update: jest.fn(async () => undefined),
  };
  (svc as any).productRepository = { findOne: jest.fn() };
  (svc as any).cryptoCipher = { encryptDeliveryTarget: (v: string) => `enc(${v})` };

  // computeSettlement / getAssignedProductIds / saveTransactionIds stubbed.
  // G004: phaseA_createAndDeduct 는 *ForBilling 변형을, SSG phaseA 는 기존 wrapper 를 호출하므로 둘 다 stub.
  (svc as any).computeSettlement = jest.fn(async () => ({
    fee: null,
    priceAdjustment: null,
    settleAmount: 30000,
    cardSurchargeApplied: false,
  }));
  (svc as any).computeSettlementForBilling = jest.fn(async () => ({
    fee: null,
    priceAdjustment: null,
    settleAmount: 30000,
    cardSurchargeApplied: false,
  }));
  (svc as any).getAssignedProductIds = jest.fn(async () => [100]);
  (svc as any).getAssignedProductIdsForBilling = jest.fn(async () => [100]);
  (svc as any).saveTransactionIds = jest.fn(async () => 'ulid-1');
  // G004: phaseA_createAndDeduct 가 맨 앞에서 resolveBillingTarget 호출. 단순모드 → billingUser=account.user.
  (svc as any).mappingResolver = {
    resolveBillingTarget: jest.fn(async () => ({
      billingUser: makeAccount().user,
      clientUserId: null,
      externalCustomerId: null,
    })),
  };

  // wallet collaborators
  const allocation = makeAllocation({ payableSettlementAmount: 30000, depositUsedAmount: 30000 });
  const build = jest.fn(async () => ({ lines: [], orderId: 1, walletAccountId: 'w-1' }));
  const allocate = jest.fn(() => allocation);
  const persistAllocation = jest.fn(async () => ({ finalAllocation: allocation }));
  const managerQuery = jest.fn(async () => ({ affectedRows: 1 }));

  (svc as any).walletCutoverConfig = { pr2DeliveryLifecycleMode: mode };
  (svc as any).dataSource = { manager: { query: managerQuery } };
  (svc as any).walletAccountResolverService = {
    resolveByUserId: jest.fn(async () => ({
      id: 'w-1',
      depositBalance: 100000,
      creditLimit: 0,
      creditUsedAmount: 0,
      settleCondition: 'PRE_PAYMENT',
    })),
  };
  (svc as any).walletAllocationInputBuilder = { build };
  (svc as any).paymentAllocationService = { allocate };
  (svc as any).orderConfirmationWalletService = { persistAllocation };
  (svc as any).deductBalance = jest.fn(async () => undefined);

  return { svc, build, allocate, persistAllocation };
}

describe('phaseA_createAndDeduct (R6 관계그래프)', () => {
  it('WALLET → 단일 mapping/delivery 그래프로 builder 호출 (빈 lines 회귀 방지)', async () => {
    const { svc, build, allocate, persistAllocation } = phaseAService(WalletCutoverMode.WALLET);
    (svc as any).productRepository.findOne = jest.fn(async () => ({
      id: 100,
      price: 30000,
      category: 'CAT',
      partnerCompany: { code: 'PC' },
      brand: { nameKorean: 'B' },
      expireDay: 30,
    }));
    const account = makeAccount();
    const dto: any = {
      productCode: 'P1',
      deliveryMethod: 'MMS',
      recipientPhone: '01000000000',
      message: '',
      title: 't',
      senderPhone: '0100',
    };

    const result = await (svc as any).phaseA_createAndDeduct(account, dto, ctx);
    // 매핑 필수 모드 플래그를 resolver 로 전달(4번째 인자 = ctx.apiApp.requireExternalCustomerId)
    expect((svc as any).mappingResolver.resolveBillingTarget.mock.calls[0][3]).toBe(false);

    expect(build).toHaveBeenCalledTimes(1);
    const orderArg = (build.mock.calls[0] as any[])[0];
    // R6: order.orderProductMappings[0].orderDeliveries[0] 가 채워져 있어야 함
    expect(orderArg.orderProductMappings).toHaveLength(1);
    expect(orderArg.orderProductMappings[0].orderDeliveries).toHaveLength(1);
    expect(orderArg.orderProductMappings[0].product).toBeDefined();
    expect(allocate).toHaveBeenCalledTimes(1);
    expect(persistAllocation).toHaveBeenCalledTimes(1);
    expect(result.order.settleAmount).toBe(30000);
  });
  it('externalOrderId 양끝 공백 → 저장 시 trim (조회/저장 정합, 멱등 회귀방지)', async () => {
    const { svc } = phaseAService(WalletCutoverMode.WALLET);
    (svc as any).productRepository.findOne = jest.fn(async () => ({
      id: 100,
      price: 30000,
      category: 'CAT',
      partnerCompany: { code: 'PC' },
      brand: { nameKorean: 'B' },
      expireDay: 30,
    }));
    const account = makeAccount();
    const dto: any = {
      productCode: 'P1',
      deliveryMethod: 'MMS',
      recipientPhone: '01000000000',
      message: '',
      title: 't',
      senderPhone: '0100',
      externalOrderId: '  ORD-1  ',
    };

    const result = await (svc as any).phaseA_createAndDeduct(account, dto, ctx);

    // 저장값은 trim — resolver.findExistingOrderByExternalOrderId(trim 조회)와 정합 → 재요청 멱등 성립
    expect(result.order.externalOrderId).toBe('ORD-1');
  });

  it('externalOrderId 공백만 → null 저장(단순모드 무영향)', async () => {
    const { svc } = phaseAService(WalletCutoverMode.WALLET);
    (svc as any).productRepository.findOne = jest.fn(async () => ({
      id: 100,
      price: 30000,
      category: 'CAT',
      partnerCompany: { code: 'PC' },
      brand: { nameKorean: 'B' },
      expireDay: 30,
    }));
    const account = makeAccount();
    const dto: any = {
      productCode: 'P1',
      deliveryMethod: 'MMS',
      recipientPhone: '01000000000',
      message: '',
      title: 't',
      senderPhone: '0100',
      externalOrderId: '   ',
    };

    const result = await (svc as any).phaseA_createAndDeduct(account, dto, ctx);

    expect(result.order.externalOrderId).toBeNull();
  });
});

describe('phaseA_createSsgAndDeduct (SSG: allocation + ssgEvent 둘 다)', () => {
  function ssgService(mode: Mode) {
    const base = phaseAService(mode);
    const deductEventBalance = jest.fn(async () => undefined);
    (base.svc as any).productService = {
      findOrCreateSsgProductByPrice: jest.fn(async () => ({
        id: 200,
        price: 50000,
        name: 'SSG상품',
        category: 'SSG',
        expireDay: 30,
        partnerCompany: { code: 'SSGPC' },
        brand: null,
      })),
    };
    (base.svc as any).ssgEventService = {
      selectEventForOrder: jest.fn(async () => ({ id: 7, expireDay: 30 })),
      deductEventBalance,
    };
    (base.svc as any).computeSettlementForBilling = jest.fn(async () => ({
      fee: null,
      priceAdjustment: null,
      settleAmount: 50000,
      cardSurchargeApplied: false,
    }));
    return { ...base, deductEventBalance };
  }

  it('WALLET → wallet allocation 생성 + ssgEvent 차감 둘 다', async () => {
    const { svc, build, allocate, persistAllocation, deductEventBalance } = ssgService(WalletCutoverMode.WALLET);
    const account = makeAccount();
    const dto: any = { amount: 50000, recipientPhone: '01000000000', message: '', senderPhone: '0100' };

    const result = await (svc as any).phaseA_createSsgAndDeduct(account, dto, ctx);
    // SSG phaseA 도 매핑 필수 모드 플래그를 resolver 로 전달(4번째 인자)
    expect((svc as any).mappingResolver.resolveBillingTarget.mock.calls[0][3]).toBe(false);

    // ssgEvent 차감 (협력사측, wallet 과 독립)
    expect(deductEventBalance).toHaveBeenCalledTimes(1);
    // wallet allocation
    expect(build).toHaveBeenCalledTimes(1);
    expect(allocate).toHaveBeenCalledTimes(1);
    expect(persistAllocation).toHaveBeenCalledTimes(1);
    const orderArg = (build.mock.calls[0] as any[])[0];
    expect(orderArg.orderProductMappings[0].orderDeliveries).toHaveLength(1);
    expect(result.ssgEvent.id).toBe(7);
  });

  it('LEGACY → raw deductBalance + ssgEvent 차감 (wallet 미경유)', async () => {
    const { svc, build, persistAllocation, deductEventBalance } = ssgService(WalletCutoverMode.LEGACY);
    const account = makeAccount();
    const dto: any = { amount: 50000, recipientPhone: '01000000000', message: '', senderPhone: '0100' };

    await (svc as any).phaseA_createSsgAndDeduct(account, dto, ctx);

    expect((svc as any).deductBalance).toHaveBeenCalledWith(account.user, 50000);
    expect(deductEventBalance).toHaveBeenCalledTimes(1);
    expect(build).not.toHaveBeenCalled();
    expect(persistAllocation).not.toHaveBeenCalled();
  });
  it('매핑모드(WALLET) → clientUserId=매핑 billingUserId 적재 + 매핑 billing wallet 차감(resolveByUserId)', async () => {
    const { svc, build, allocate, persistAllocation, deductEventBalance } = ssgService(WalletCutoverMode.WALLET);
    const mappedBillingUser = { id: 99, company: undefined, settleMethod: 'CASH' } as any;
    (svc as any).mappingResolver.resolveBillingTarget = jest.fn(async () => ({
      billingUser: mappedBillingUser,
      clientUserId: 99,
      externalCustomerId: 'wisead-c1',
    }));
    const account = makeAccount();
    const dto: any = {
      amount: 50000,
      recipientPhone: '01000000000',
      message: '',
      senderPhone: '0100',
      externalCustomerId: 'wisead-c1',
      externalOrderId: 'WA-1',
    };

    const result = await (svc as any).phaseA_createSsgAndDeduct(account, dto, ctx);

    // 매핑 billing 적재: clientUserId=99, externalCustomerId/externalOrderId 저장, userId 는 default billing 유지
    expect(result.order.clientUserId).toBe(99);
    expect(result.order.externalCustomerId).toBe('wisead-c1');
    expect(result.order.externalOrderId).toBe('WA-1');
    expect(result.order.userId).toBe(account.user.id);
    // 매핑 billing wallet 차감 (resolveByUserId(99))
    expect((svc as any).walletAccountResolverService.resolveByUserId).toHaveBeenCalledWith(99, expect.anything());
    expect(build).toHaveBeenCalledTimes(1);
    expect(allocate).toHaveBeenCalledTimes(1);
    expect(persistAllocation).toHaveBeenCalledTimes(1);
    expect(deductEventBalance).toHaveBeenCalledTimes(1);
  });
});

// ─── externalOrderId 비즈니스 멱등 재생 (신규 차감 없음) ───
// 멱등 계약: 동일 (apiApp, externalOrderId) 기존 주문이면 phaseA(차감) 없이 기존 응답을 재생한다.
describe('externalOrderId 멱등 재생 (신규 차감 없음)', () => {
  it('일반 주문: 기존 주문 존재 → phaseA 미호출, 기존 응답 재생', async () => {
    const svc = Object.create(ExternalApiService.prototype) as any;
    const existing = { id: 555 };
    svc.mappingResolver = { findExistingOrderByExternalOrderId: jest.fn(async () => existing) };
    svc.buildCreateResponseForExistingOrder = jest.fn(() => ({ result: { code: '0000' } }));
    svc.phaseA_createAndDeduct = jest.fn();

    const res = await svc.createOrder(
      {},
      { productCode: 'P1', recipientPhone: '0100', senderPhone: '0100', externalOrderId: 'WA-1' },
      { apiApp: { id: '1', requireExternalCustomerId: false } },
    );

    expect(svc.mappingResolver.findExistingOrderByExternalOrderId).toHaveBeenCalledWith('1', 'WA-1');
    expect(svc.buildCreateResponseForExistingOrder).toHaveBeenCalledWith(existing);
    expect(svc.phaseA_createAndDeduct).not.toHaveBeenCalled();
    expect(res).toEqual({ result: { code: '0000' } });
  });

  it('SSG 주문: 기존 주문 존재 → phaseA 미호출, 기존 응답 재생', async () => {
    const svc = Object.create(ExternalApiService.prototype) as any;
    const existing = { id: 777 };
    svc.mappingResolver = { findExistingOrderByExternalOrderId: jest.fn(async () => existing) };
    svc.buildSsgCreateResponseForExistingOrder = jest.fn(() => ({ result: { code: '0000' } }));
    svc.phaseA_createSsgAndDeduct = jest.fn();

    const res = await svc.createSsgOrder(
      {},
      { amount: 50000, recipientPhone: '0100', externalOrderId: 'WA-2' },
      { apiApp: { id: '1', ssgEnabled: true, requireExternalCustomerId: false } },
    );

    expect(svc.mappingResolver.findExistingOrderByExternalOrderId).toHaveBeenCalledWith('1', 'WA-2');
    expect(svc.buildSsgCreateResponseForExistingOrder).toHaveBeenCalledWith(existing);
    expect(svc.phaseA_createSsgAndDeduct).not.toHaveBeenCalled();
    expect(res).toEqual({ result: { code: '0000' } });
  });
});
