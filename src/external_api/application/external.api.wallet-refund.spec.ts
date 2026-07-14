import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';
import { BadRequestException } from '@nestjs/common';
import { ExternalApiService } from './external.api.service';

// @Transactional() 데코레이터가 phaseC_handleFailure / processCancelRefund 를 감싸므로
// storage driver + 더미 data source 가 필요. callback 은 빈 manager({})를 받지만, 본 테스트는
// svc.dataSource.manager(직접 주입한 mock)를 사용하므로 TX manager 인자는 영향 없음.
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
import { ExternalApiException } from '../api/external.api.exception.filter';
import { WalletCutoverMode } from '../../wallet/config/wallet-cutover.config';
import { OrderPaymentRefundEventType } from '../../entity/order.payment.refund.event.entity';
import { ExternalApiAccountEntity } from '../../entity/external.api.account.entity';
import { OrderEntity } from '../../entity/order.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { IOrderType } from '../../order/interface/order.type';
import { IOrderStatus } from '../../order/interface/order.status';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { SsgRecoveryResult } from '../../delivery/interface/ssg.recovery.result';

// External API 환불(실패/취소) + 재발송 가드 wallet 정합화 단위 테스트.
//   - R7-A: phaseC_handleFailure claim 멱등 흡수.
//   - R2: 환불 wallet 분기 (FAIL_REFUND / DISCARD_REFUND) + R4 차감 mirror 역복원.
//   - R3: resendOrder 가드.

function makeAccount(over?: { isCompany?: boolean }): ExternalApiAccountEntity {
  const company = over?.isCompany ? { id: 9, balanceManagementType: 'COMPANY', settleMethod: 'CASH' } : undefined;
  return {
    user: {
      id: 42,
      companyId: over?.isCompany ? 9 : null,
      settleMethod: 'CASH',
      company,
    },
  } as any;
}

function makeOrder(over?: Partial<OrderEntity>): OrderEntity {
  return {
    id: 1,
    // G004: loadOrderBillingUser(order, account.user) 가 getBillingUserId(order)=clientUserId??userId 로 분기.
    // userId 를 account.user.id(=42)와 정렬 → fallback(account.user) 재사용(단순모드 비트동일, userRepository 미조회).
    userId: 42,
    clientUserId: null,
    type: IOrderType.EXTERNAL,
    status: IOrderStatus.DELIVERY_REQUEST,
    settleAmount: 30000,
    sendAmount: 30000,
    isSettleBalance: true,
    isSettleComplete: false,
    ...over,
  } as any;
}

function makeOrderDelivery(over?: Partial<OrderDeliveryEntity>): OrderDeliveryEntity {
  return {
    id: 55,
    ssgEventId: null,
    couponStatus: OrderDeliveryCouponStatus.NOT_USED,
    barCode: 'BC-1',
    resendCount: 0,
    ...over,
  } as any;
}

/**
 * phaseC_handleFailure / processCancelRefund 단위 구동용 service.
 * manager.findOne 은 OrderDeliveryAttempt(INITIAL) + OrderPaymentAllocation 을 반환하도록 entity 별 분기.
 */
function refundService(opts: {
  isWalletManaged: boolean;
  claimThrows?: Error;
  allocation?: { depositUsedAmount: number; creditUsedAmount: number; creditExcessAmount: number };
  attempt?: { id: string } | null;
  recoverResult?: SsgRecoveryResult;
  refundAlreadyRefunded?: boolean;
}) {
  const svc = Object.create(ExternalApiService.prototype) as ExternalApiService;
  (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };

  const queries: Array<{ sql: string; params: any[] }> = [];
  const managerQuery = jest.fn(async (sql: string, params: any[]) => {
    queries.push({ sql, params });
    return { affectedRows: 1 };
  });
  const attempt = opts.attempt === undefined ? { id: '777' } : opts.attempt;
  const allocation = opts.allocation ?? {
    depositUsedAmount: 30000,
    creditUsedAmount: 0,
    creditExcessAmount: 0,
  };
  const managerFindOne = jest.fn(async (entity: any) => {
    const name = entity?.name ?? '';
    if (name.includes('Attempt')) return attempt;
    if (name.includes('Allocation')) return allocation;
    return null;
  });
  (svc as any).dataSource = { manager: { query: managerQuery, findOne: managerFindOne } };

  (svc as any).orderRepository = { save: jest.fn(async (o: any) => o) };
  (svc as any).orderDeliveryRepository = { save: jest.fn(async (o: any) => o) };
  // G004: loadOrderBillingUser fallback 미스 시 userRepository.findOne 로 재조회. 안전망으로 account.user 반환.
  (svc as any).userRepository = {
    findOne: jest.fn(async () => makeAccount().user),
  };

  const claim = jest.fn(async () => {
    if (opts.claimThrows) throw opts.claimThrows;
  });
  const refund = jest.fn(async () => ({
    ledgerIds: ['l1'],
    totalRefundedAmount: 30000,
    alreadyRefunded: opts.refundAlreadyRefunded ?? false,
  }));
  const refundBalance = jest.fn(async () => undefined);
  const recoverWithLease = jest.fn(async () => opts.recoverResult ?? SsgRecoveryResult.RESTORED);
  const syncDeposit = jest.fn(async () => undefined);

  (svc as any).refundLedgerService = { claim };
  (svc as any).refundPoolService = { refund };
  (svc as any).ssgRecoveryService = { recoverWithLease };
  (svc as any).walletManagedPredicate = {
    isWalletManaged: jest.fn(async () => opts.isWalletManaged),
  };
  // refundBalance 는 private. spy 로 가로채 legacy 경로 호출 검증.
  (svc as any).refundBalance = refundBalance;
  // 레거시 예치금 wallet 동기화 목 (legacy 경로에서만 호출됨).
  (svc as any).legacyWalletCreditSyncService = { syncCredit: jest.fn(), syncDeposit };

  return {
    svc,
    queries,
    mocks: { managerQuery, managerFindOne, claim, refund, refundBalance, recoverWithLease, syncDeposit },
  };
}

describe('phaseC_handleFailure — R7-A claim 멱등 + R2 wallet 환불', () => {
  it('WALLET 발송실패 → FAIL_REFUND 풀 환불 + legacy mirror 역복원(deposit), refundBalance 미호출', async () => {
    const { svc, queries, mocks } = refundService({
      isWalletManaged: true,
      allocation: { depositUsedAmount: 30000, creditUsedAmount: 0, creditExcessAmount: 0 },
    });
    const account = makeAccount({ isCompany: true });
    const order = makeOrder();
    const orderDelivery = makeOrderDelivery();

    await (svc as any).phaseC_handleFailure(order, orderDelivery, account, new Error('발송 실패'));

    expect(mocks.claim).toHaveBeenCalledTimes(1);
    // FAIL_REFUND + INITIAL attempt 기반 prefix
    const refundArg = (mocks.refund.mock.calls[0] as any[])[0];
    expect(refundArg.eventType).toBe(OrderPaymentRefundEventType.FAIL_REFUND);
    expect(refundArg.idempotencyKeyPrefix).toBe('fail_refund:1:55:777');
    expect(refundArg.targetDeliveryIds).toEqual([55]);

    // legacy mirror 역복원: company.balance += depositUsed, allSettleAmount -= 0
    const companyUpdate = queries.find((q) => q.sql.includes('user_company SET balance = balance + ?'));
    expect(companyUpdate!.params).toEqual([30000, 9]);
    const allSettleUpdate = queries.find((q) => q.sql.includes('all_settle_amount = all_settle_amount - ?'));
    expect(allSettleUpdate!.params).toEqual([0, 42]);

    // wallet path → raw refundBalance 미호출 (이중복원 없음)
    expect(mocks.refundBalance).not.toHaveBeenCalled();
    // wallet-managed → legacy 예치금 sync 미호출 (wallet 경로가 이미 처리)
    expect(mocks.syncDeposit).not.toHaveBeenCalled();
    // user.balance 미기록
    expect(queries.some((q) => /UPDATE user SET balance/.test(q.sql))).toBe(false);
  });

  it('WALLET 멱등 retry(alreadyRefunded=true) → 풀 no-op, legacy mirror skip(잔액 이중복원 차단)', async () => {
    const { svc, queries, mocks } = refundService({
      isWalletManaged: true,
      refundAlreadyRefunded: true,
      allocation: { depositUsedAmount: 30000, creditUsedAmount: 0, creditExcessAmount: 0 },
    });
    const account = makeAccount({ isCompany: true });

    await (svc as any).phaseC_handleFailure(makeOrder(), makeOrderDelivery(), account, new Error('x'));

    // 풀 refund 는 호출되지만 멱등 no-op → mirror UPDATE 한 건도 실행되면 안 됨
    expect(mocks.refund).toHaveBeenCalledTimes(1);
    expect(queries.some((q) => q.sql.includes('user_company SET balance'))).toBe(false);
    expect(queries.some((q) => q.sql.includes('all_settle_amount = all_settle_amount - ?'))).toBe(false);
    expect(mocks.refundBalance).not.toHaveBeenCalled();
  });

  it('WALLET 후정산 여신 → allSettleAmount -= (creditUsed+creditExcess), company 미터치(PERSONAL)', async () => {
    const { svc, queries } = refundService({
      isWalletManaged: true,
      allocation: { depositUsedAmount: 0, creditUsedAmount: 40000, creditExcessAmount: 10000 },
    });
    const account = makeAccount({ isCompany: false });

    await (svc as any).phaseC_handleFailure(makeOrder(), makeOrderDelivery(), account, new Error('x'));

    const allSettleUpdate = queries.find((q) => q.sql.includes('all_settle_amount = all_settle_amount - ?'));
    expect(allSettleUpdate!.params).toEqual([50000, 42]);
    expect(queries.some((q) => q.sql.includes('user_company'))).toBe(false);
  });

  it('claim 중복 + wallet-managed → 흡수 후 멱등 재시도(refund 1회), short-circuit return 안 함', async () => {
    const { svc, mocks } = refundService({
      isWalletManaged: true,
      claimThrows: new BadRequestException('already claimed'),
    });

    await (svc as any).phaseC_handleFailure(makeOrder(), makeOrderDelivery(), makeAccount(), new Error('x'));

    // 흡수 후 wallet refund 가 여전히 실행됨 (멱등 — RefundPoolService 가 중복 흡수)
    expect(mocks.refund).toHaveBeenCalledTimes(1);
    expect(mocks.refundBalance).not.toHaveBeenCalled();
  });

  it('claim 중복 + legacy → short-circuit return (중복 환불 0)', async () => {
    const { svc, mocks } = refundService({
      isWalletManaged: false,
      claimThrows: new BadRequestException('already claimed'),
    });

    await (svc as any).phaseC_handleFailure(makeOrder(), makeOrderDelivery(), makeAccount(), new Error('x'));

    expect(mocks.refund).not.toHaveBeenCalled();
    expect(mocks.refundBalance).not.toHaveBeenCalled();
  });

  it('SSG 발송실패 → recoverWithLease 단일 CAS 게이트 경유 (resolver 직접 호출 안 함, 선체크 isSsgSettled 제거)', async () => {
    const { svc, mocks } = refundService({ isWalletManaged: true });
    const order = makeOrder({ type: IOrderType.SSG, sendAmount: 25000 });
    const orderDelivery = makeOrderDelivery({ ssgEventId: 7 });

    await (svc as any).phaseC_handleFailure(order, orderDelivery, makeAccount(), new Error('x'));

    // (orderDeliveryId, ssgEventId, orderId, sendAmount 스냅샷) 으로 lease 게이트 경유.
    expect(mocks.recoverWithLease).toHaveBeenCalledTimes(1);
    expect(mocks.recoverWithLease).toHaveBeenCalledWith(55, 7, 1, 25000);
    // wallet refund 는 여전히 진행
    expect(mocks.refund).toHaveBeenCalledTimes(1);
  });

  it('SSG + claim 중복(wallet retry) → settled=true 면 CAS 가 SKIPPED_NO_CLAIM 로 거름, wallet refund 진행', async () => {
    const { svc, mocks } = refundService({
      isWalletManaged: true,
      claimThrows: new BadRequestException('dup'),
      recoverResult: SsgRecoveryResult.SKIPPED_NO_CLAIM,
    });
    const order = makeOrder({ type: IOrderType.SSG });
    const orderDelivery = makeOrderDelivery({ ssgEventId: 7 });

    await (svc as any).phaseC_handleFailure(order, orderDelivery, makeAccount(), new Error('x'));

    expect(mocks.recoverWithLease).toHaveBeenCalledTimes(1);
    expect(mocks.refund).toHaveBeenCalledTimes(1);
  });

  it('SSG + recoverWithLease DEFERRED → 운영 점검 error 로그, wallet 환불은 진행', async () => {
    const { svc, mocks } = refundService({
      isWalletManaged: true,
      recoverResult: SsgRecoveryResult.DEFERRED,
    });
    const order = makeOrder({ type: IOrderType.SSG });
    const orderDelivery = makeOrderDelivery({ ssgEventId: 7 });

    await (svc as any).phaseC_handleFailure(order, orderDelivery, makeAccount(), new Error('x'));

    expect(mocks.recoverWithLease).toHaveBeenCalledTimes(1);
    expect((svc as any).logger.error).toHaveBeenCalled();
    expect(mocks.refund).toHaveBeenCalledTimes(1);
  });

  it('LEGACY 발송실패 → 기존 refundBalance 회귀 0 (wallet refund 미호출)', async () => {
    const { svc, mocks } = refundService({ isWalletManaged: false });

    await (svc as any).phaseC_handleFailure(makeOrder(), makeOrderDelivery(), makeAccount(), new Error('x'));

    expect(mocks.refund).not.toHaveBeenCalled();
    expect(mocks.refundBalance).toHaveBeenCalledWith(expect.anything(), 30000);
    // legacy → 예치금 wallet 동기화 호출 (FAIL_REFUND, +settleAmount)
    expect(mocks.syncDeposit).toHaveBeenCalledTimes(1);
    expect(mocks.syncDeposit).toHaveBeenCalledWith(expect.anything(), {
      billingUserId: 42,
      orderId: 1,
      orderDeliveryId: 55,
      delta: 30000,
      type: 'FAIL_REFUND',
      idempotencyKey: 'legacy_fail_refund:1:55:deposit',
      memo: expect.any(String),
    });
  });

  it('WALLET-managed인데 INITIAL attempt 없음 → drift throw', async () => {
    const { svc } = refundService({ isWalletManaged: true, attempt: null });

    await expect(
      (svc as any).phaseC_handleFailure(makeOrder(), makeOrderDelivery(), makeAccount(), new Error('x')),
    ).rejects.toThrow(/missing INITIAL attempt/);
  });
});

describe('processCancelRefund — R2 wallet 환불 (DISCARD_REFUND)', () => {
  it('WALLET 취소 → DISCARD_REFUND 풀 환불 + legacy mirror 역복원', async () => {
    const { svc, queries, mocks } = refundService({
      isWalletManaged: true,
      allocation: { depositUsedAmount: 30000, creditUsedAmount: 0, creditExcessAmount: 0 },
    });
    const account = makeAccount({ isCompany: true });

    await (svc as any).processCancelRefund(makeOrder(), makeOrderDelivery(), account);

    const refundArg = (mocks.refund.mock.calls[0] as any[])[0];
    expect(refundArg.eventType).toBe(OrderPaymentRefundEventType.DISCARD_REFUND);
    expect(refundArg.idempotencyKeyPrefix).toBe('discard_refund:1:55:777');

    const companyUpdate = queries.find((q) => q.sql.includes('user_company SET balance = balance + ?'));
    expect(companyUpdate!.params).toEqual([30000, 9]);
    expect(mocks.refundBalance).not.toHaveBeenCalled();
    // wallet-managed → legacy 예치금 sync 미호출
    expect(mocks.syncDeposit).not.toHaveBeenCalled();
  });

  it('LEGACY 취소 → 기존 refundBalance 회귀 0', async () => {
    const { svc, mocks } = refundService({ isWalletManaged: false });

    await (svc as any).processCancelRefund(makeOrder(), makeOrderDelivery(), makeAccount());

    expect(mocks.refund).not.toHaveBeenCalled();
    expect(mocks.refundBalance).toHaveBeenCalledWith(expect.anything(), 30000);
    // legacy → 예치금 wallet 동기화 호출 (DISCARD_REFUND, +settleAmount)
    expect(mocks.syncDeposit).toHaveBeenCalledTimes(1);
    expect(mocks.syncDeposit).toHaveBeenCalledWith(expect.anything(), {
      billingUserId: 42,
      orderId: 1,
      orderDeliveryId: 55,
      delta: 30000,
      type: 'DISCARD_REFUND',
      idempotencyKey: 'legacy_discard_refund:1:55:deposit',
      memo: expect.any(String),
    });
  });
});

describe('resendOrder — R3 가드', () => {
  function resendService(order: OrderEntity, orderDelivery: Partial<OrderDeliveryEntity>) {
    const svc = Object.create(ExternalApiService.prototype) as ExternalApiService;
    (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
    const full = makeOrderDelivery({ ...orderDelivery, orderProductMapping: { order } } as any);
    (svc as any).findOrderDeliveryByTrId = jest.fn(async () => full);
    const dispatchSend = jest.fn(async () => ({ isSuccess: true }));
    (svc as any).dispatchSend = dispatchSend;
    (svc as any).resolveResendMax = jest.fn(() => 3);
    // 재발송 슬롯 atomic claim 은 createQueryBuilder().update()...execute() 체인 + 성공 후 targeted update 를 사용.
    // (G004 와 무관한 기존 mock 누락 보강 — 단언/검증 강도는 그대로.)
    const claimQb: any = {
      update: () => claimQb,
      set: () => claimQb,
      where: () => claimQb,
      andWhere: () => claimQb,
      execute: jest.fn(async () => ({ affected: 1 })),
    };
    (svc as any).orderDeliveryRepository = {
      save: jest.fn(async (o: any) => o),
      update: jest.fn(async () => undefined),
      findOne: jest.fn(async () => null),
      createQueryBuilder: jest.fn(() => claimQb),
    };
    return { svc, dispatchSend };
  }

  it('DELIVERY_CANCEL 주문 재발송 → 3005 거절 (dispatch 미호출)', async () => {
    const { svc, dispatchSend } = resendService(makeOrder({ status: IOrderStatus.DELIVERY_CANCEL }), {});
    await expect((svc as any).resendOrder(makeAccount(), 'tr')).rejects.toMatchObject({ code: '3005' });
    expect(dispatchSend).not.toHaveBeenCalled();
  });

  it('couponStatus CANCEL → 3005 거절', async () => {
    const { svc, dispatchSend } = resendService(makeOrder({ status: IOrderStatus.DELIVERY_COMPLETE }), {
      couponStatus: OrderDeliveryCouponStatus.CANCEL,
    });
    await expect((svc as any).resendOrder(makeAccount(), 'tr')).rejects.toMatchObject({ code: '3005' });
    expect(dispatchSend).not.toHaveBeenCalled();
  });

  it('DELIVERY_COMPLETE + 정상 쿠폰 → 허용 (재발송 진행)', async () => {
    const { svc, dispatchSend } = resendService(makeOrder({ status: IOrderStatus.DELIVERY_COMPLETE }), {
      barCode: 'BC-1',
      resendCount: 0,
    });
    const res = await (svc as any).resendOrder(makeAccount(), 'tr');
    expect(dispatchSend).toHaveBeenCalledTimes(1);
    expect(res).toBeDefined();
  });

  it('DELIVERY_COMPLETE 이지만 barCode 없음 → 3004 (기존 체크 유지)', async () => {
    const { svc } = resendService(makeOrder({ status: IOrderStatus.DELIVERY_COMPLETE }), { barCode: null as any });
    await expect((svc as any).resendOrder(makeAccount(), 'tr')).rejects.toMatchObject({ code: '3004' });
  });
});
