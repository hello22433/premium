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
import {
  OrderPaymentRefundEventEntity,
  OrderPaymentRefundEventType,
} from '../../entity/order.payment.refund.event.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { RefundAttemptStatus } from '../../delivery/interface/refund.attempt.status';
import { ExternalApiAccountEntity } from '../../entity/external.api.account.entity';
import { OrderEntity } from '../../entity/order.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { IOrderType } from '../../order/interface/order.type';
import { IOrderStatus } from '../../order/interface/order.status';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { SsgRecoveryResult } from '../../delivery/interface/ssg.recovery.result';
import { ActivityLogActionType } from '../../activity_log/interface/activity.log.action.type';
import {
  SsgIssueAlreadyConfirmedError,
  SsgIssueAttemptAlreadyActiveError,
  SsgIssueRejectedError,
  SsgIssueUnknownError,
} from '../../partner_company_extern/infra/ssg.issue';

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

/** cancelOrder 가 획득한 변형 lease 토큰. processCancelRefund 의 fencing 조건. */
const LEASE_TOKEN = new Date('2026-07-24T00:00:00.000Z');

/**
 * phaseC_handleFailure / processCancelRefund 단위 구동용 service.
 * manager.findOne 은 OrderDeliveryAttempt(INITIAL) + OrderPaymentAllocation 을 반환하도록 entity 별 분기.
 */
function refundService(opts: {
  isWalletManaged: boolean;
  claimThrows?: Error;
  allocation?: { depositUsedAmount: number; creditUsedAmount: number; creditExcessAmount: number };
  refundBreakdown?: {
    depositAmount: number;
    creditAmount: number;
    creditExcessAmount: number;
    pointAmount?: number;
    pointSkippedExpiredAmount?: number;
  };
  attempt?: { id: string } | null;
  recoverResult?: SsgRecoveryResult;
  refundAlreadyRefunded?: boolean;
  /** 취소 상태 쓰기의 fencing 결과. 0 이면 lease 를 뺏긴 상황(기본 1 = 정상 소유). */
  updateAffected?: number;
}) {
  const svc = Object.create(ExternalApiService.prototype) as ExternalApiService;
  // §9 컷오버 게이트 — 단위 테스트 기본값은 '미전환 건'(legacy 경로 그대로 통과).
  (svc as any).cutoverGuard = {
    assertLegacyAllowed: jest.fn().mockResolvedValue(undefined),
    assertRefundExecutionAllowed: jest.fn().mockResolvedValue(undefined),
    isCutover: jest.fn().mockResolvedValue(false),
    splitLegacyAllowed: jest.fn(async (ids: number[]) => ({ allowed: ids, blocked: [] })),
  };
  const logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  (svc as any).logger = logger;

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
  const refundBreakdown = opts.refundBreakdown ?? {
    depositAmount: allocation.depositUsedAmount,
    creditAmount: allocation.creditUsedAmount,
    creditExcessAmount: allocation.creditExcessAmount,
  };
  const managerFindOne = jest.fn(async (entity: any) => {
    const name = entity?.name ?? '';
    if (name.includes('Attempt')) return attempt;
    if (name.includes('Allocation')) return allocation;
    return null;
  });
  const transactionManager = { query: managerQuery, findOne: managerFindOne };
  const transaction = jest.fn(async (_isolation: string, callback: (manager: typeof transactionManager) => unknown) =>
    callback(transactionManager),
  );
  (svc as any).dataSource = {
    manager: transactionManager,
    transaction,
  };

  (svc as any).orderRepository = { save: jest.fn(async (o: any) => o) };
  // processCancelRefund 의 상태 쓰기는 save(merge) 가 아니라 targeted update 다 (D3-60).
  // UpdateResult 형태로 반환해야 후속 fencing(affected 검사)까지 태울 수 있다.
  const odSave = jest.fn(async (o: any) => o);
  const odUpdate = jest.fn(async () => ({ affected: opts.updateAffected ?? 1 }));
  (svc as any).orderDeliveryRepository = { save: odSave, update: odUpdate };
  // G004: loadOrderBillingUser fallback 미스 시 userRepository.findOne 로 재조회. 안전망으로 account.user 반환.
  (svc as any).userRepository = {
    findOne: jest.fn(async () => makeAccount().user),
  };

  const claim = jest.fn(async () => {
    if (opts.claimThrows) throw opts.claimThrows;
  });
  const getLedgerId = jest.fn(async () => 991);
  const refund = jest.fn(async () => ({
    ledgerIds: ['l1'],
    totalRefundedAmount:
      (refundBreakdown.pointAmount ?? 0) +
      refundBreakdown.depositAmount +
      refundBreakdown.creditAmount +
      refundBreakdown.creditExcessAmount,
    refundedPointAmount: refundBreakdown.pointAmount ?? 0,
    refundedDepositAmount: refundBreakdown.depositAmount,
    refundedCreditUsedAmount: refundBreakdown.creditAmount,
    refundedCreditExcessAmount: refundBreakdown.creditExcessAmount,
    pointSkippedExpiredAmount: refundBreakdown.pointSkippedExpiredAmount ?? 0,
    alreadyRefunded: opts.refundAlreadyRefunded ?? false,
  }));
  const refundBalance = jest.fn(async () => ({
    beforeBalance: 70000,
    afterBalance: 100000,
    balanceManagementType: 'ACCOUNT',
  }));
  const recoverWithLease = jest.fn(async () => opts.recoverResult ?? SsgRecoveryResult.RESTORED);
  const syncDeposit = jest.fn(async () => undefined);
  const createLog = jest.fn(async () => 1);

  (svc as any).refundLedgerService = { claim, getLedgerId };
  (svc as any).refundPoolService = { refund };
  (svc as any).ssgRecoveryService = { recoverWithLease };
  (svc as any).walletManagedPredicate = {
    isWalletManaged: jest.fn(async () => opts.isWalletManaged),
  };
  // refundBalance 는 private. spy 로 가로채 legacy 경로 호출 검증.
  (svc as any).refundBalance = refundBalance;
  // 레거시 예치금 wallet 동기화 목 (legacy 경로에서만 호출됨).
  (svc as any).legacyWalletCreditSyncService = { syncCredit: jest.fn(), syncDeposit };
  (svc as any).activityLogService = { createLog };

  return {
    svc,
    queries,
    mocks: {
      managerQuery,
      managerFindOne,
      claim,
      transaction,
      transactionManager,
      getLedgerId,
      refund,
      refundBalance,
      recoverWithLease,
      syncDeposit,
      createLog,
      odSave,
      odUpdate,
      logger,
    },
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
    expect(mocks.transaction).toHaveBeenCalledWith('READ COMMITTED', expect.any(Function));
    expect((mocks.refund.mock.calls[0] as any[])[1]).toBe(mocks.transactionManager);

    // legacy mirror 역복원: 실제 환불된 예치금만 company.balance에 반영하고 0원 여신 UPDATE는 생략한다.
    const companyUpdate = queries.find((q) => q.sql.includes('user_company SET balance = balance + ?'));
    expect(companyUpdate!.params).toEqual([30000, 9]);
    expect(queries.some((q) => q.sql.includes('all_settle_amount = all_settle_amount - ?'))).toBe(false);

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
  it.each([
    ['UNKNOWN', new SsgIssueUnknownError('SSG 후보 판정 미확정(UNKNOWN)')],
    ['MULTIPLE', new SsgIssueUnknownError('SSG 후보 판정 미확정(MULTIPLE_CONFIRMED)')],
    ['stale active completion', new SsgIssueAttemptAlreadyActiveError(55)],
    ['stale confirmed completion', new SsgIssueAlreadyConfirmedError(55)],
  ])('SSG %s는 WAIT/운영 보류를 유지하고 FAIL·환불을 수행하지 않는다', async (_case, error) => {
    const { svc, mocks } = refundService({ isWalletManaged: true });
    const order = makeOrder({ type: IOrderType.SSG });
    const orderDelivery = makeOrderDelivery({ ssgEventId: 7, status: IOrderDeliveryStatus.WAIT });

    await (svc as any).phaseC_handleFailure(order, orderDelivery, makeAccount(), error);

    expect(orderDelivery.status).toBe(IOrderDeliveryStatus.WAIT);
    expect(mocks.odUpdate).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.recoverWithLease).not.toHaveBeenCalled();
    expect(mocks.refund).not.toHaveBeenCalled();
    expect(mocks.refundBalance).not.toHaveBeenCalled();
  });

  it('SSG 확정 거절은 기존 FAIL·환불 경로로 처리한다', async () => {
    const { svc, mocks } = refundService({ isWalletManaged: true });
    const order = makeOrder({ type: IOrderType.SSG });
    const orderDelivery = makeOrderDelivery({ ssgEventId: 7 });

    await (svc as any).phaseC_handleFailure(
      order,
      orderDelivery,
      makeAccount(),
      new SsgIssueRejectedError('1001', 'SSG INSERT rejected'),
    );

    expect(mocks.odUpdate).toHaveBeenCalled();
    expect(mocks.claim).toHaveBeenCalledTimes(1);
    expect(mocks.recoverWithLease).toHaveBeenCalledTimes(1);
    expect(mocks.refund).toHaveBeenCalledTimes(1);
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
    expect(mocks.createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        requestUrl: '/system/balance/refund',
        actionType: ActivityLogActionType.BALANCE_REFUND,
        requestParams: expect.objectContaining({
          sourcePath: 'EXTERNAL_FAIL',
          orderId: 1,
          orderDeliveryId: 55,
          refundLedgerId: 991,
          chargeAmount: 30000,
        }),
      }),
      expect.anything(),
    );
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

    await (svc as any).processCancelRefund(makeOrder(), makeOrderDelivery(), account, LEASE_TOKEN);

    const refundArg = (mocks.refund.mock.calls[0] as any[])[0];
    expect(refundArg.eventType).toBe(OrderPaymentRefundEventType.DISCARD_REFUND);
    expect(refundArg.idempotencyKeyPrefix).toBe('discard_refund:1:55:777');

    const companyUpdate = queries.find((q) => q.sql.includes('user_company SET balance = balance + ?'));
    expect(companyUpdate!.params).toEqual([30000, 9]);
    expect(mocks.refundBalance).not.toHaveBeenCalled();
    // wallet-managed → legacy 예치금 sync 미호출
    expect(mocks.syncDeposit).not.toHaveBeenCalled();
  });

  it('WALLET 혼합재원 취소는 allocation 전체가 아니라 개별 환불 결과만 mirror에 반영한다', async () => {
    const { svc, queries } = refundService({
      isWalletManaged: true,
      allocation: { depositUsedAmount: 30000, creditUsedAmount: 20000, creditExcessAmount: 0 },
      refundBreakdown: {
        depositAmount: 5000,
        creditAmount: 3000,
        creditExcessAmount: 0,
      },
    });

    await (svc as any).processCancelRefund(
      makeOrder(),
      makeOrderDelivery(),
      makeAccount({ isCompany: true }),
      LEASE_TOKEN,
    );

    const companyUpdate = queries.find((q) => q.sql.includes('user_company SET balance = balance + ?'));
    expect(companyUpdate!.params).toEqual([5000, 9]);
    const allSettleUpdate = queries.find((q) => q.sql.includes('all_settle_amount = all_settle_amount - ?'));
    expect(allSettleUpdate!.params).toEqual([3000, 42]);
  });

  it('LEGACY 취소 → 기존 refundBalance 회귀 0', async () => {
    const { svc, mocks } = refundService({ isWalletManaged: false });

    await (svc as any).processCancelRefund(makeOrder(), makeOrderDelivery(), makeAccount(), LEASE_TOKEN);

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
    expect(mocks.createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        requestUrl: '/system/balance/refund',
        actionType: ActivityLogActionType.BALANCE_REFUND,
        requestParams: expect.objectContaining({
          sourcePath: 'EXTERNAL_CANCEL',
          orderId: 1,
          orderDeliveryId: 55,
          refundLedgerId: 991,
          chargeAmount: 30000,
        }),
      }),
      expect.anything(),
    );
  });
});

describe('refundBalance — 레거시 환불 감사 로그 전 잔액 복원 검증', () => {
  it('사용자 잔액 UPDATE 대상이 없으면 시스템 오류로 중단한다', async () => {
    const svc = Object.create(ExternalApiService.prototype) as ExternalApiService;
    // §9 컷오버 게이트 — 단위 테스트 기본값은 '미전환 건'(legacy 경로 그대로 통과).
    (svc as any).cutoverGuard = {
      assertLegacyAllowed: jest.fn().mockResolvedValue(undefined),
      assertRefundExecutionAllowed: jest.fn().mockResolvedValue(undefined),
      isCutover: jest.fn().mockResolvedValue(false),
      splitLegacyAllowed: jest.fn(async (ids: number[]) => ({ allowed: ids, blocked: [] })),
    };
    const query = jest.fn(async () => ({ affectedRows: 0 }));
    (svc as any).dataSource = { manager: { query } };

    await expect((svc as any).refundBalance(makeAccount().user, 30000)).rejects.toMatchObject({
      code: '9999',
    });

    expect(query).toHaveBeenCalledTimes(1);
  });

  it('사용자 잔액 UPDATE 후 잔액 재조회가 실패하면 시스템 오류로 중단한다', async () => {
    const svc = Object.create(ExternalApiService.prototype) as ExternalApiService;
    // §9 컷오버 게이트 — 단위 테스트 기본값은 '미전환 건'(legacy 경로 그대로 통과).
    (svc as any).cutoverGuard = {
      assertLegacyAllowed: jest.fn().mockResolvedValue(undefined),
      assertRefundExecutionAllowed: jest.fn().mockResolvedValue(undefined),
      isCutover: jest.fn().mockResolvedValue(false),
      splitLegacyAllowed: jest.fn(async (ids: number[]) => ({ allowed: ids, blocked: [] })),
    };
    const query = jest.fn(async (sql: string) => {
      if (sql.startsWith('UPDATE user SET')) return { affectedRows: 1 };
      return [];
    });
    (svc as any).dataSource = { manager: { query } };

    await expect((svc as any).refundBalance(makeAccount().user, 30000)).rejects.toMatchObject({
      code: '9999',
    });

    expect(query).toHaveBeenCalledTimes(2);
  });

  it('회사 잔액 UPDATE 후 재조회된 잔액으로 전후 잔액을 반환한다', async () => {
    const svc = Object.create(ExternalApiService.prototype) as ExternalApiService;
    // §9 컷오버 게이트 — 단위 테스트 기본값은 '미전환 건'(legacy 경로 그대로 통과).
    (svc as any).cutoverGuard = {
      assertLegacyAllowed: jest.fn().mockResolvedValue(undefined),
      assertRefundExecutionAllowed: jest.fn().mockResolvedValue(undefined),
      isCutover: jest.fn().mockResolvedValue(false),
      splitLegacyAllowed: jest.fn(async (ids: number[]) => ({ allowed: ids, blocked: [] })),
    };
    const query = jest.fn(async (sql: string) => {
      if (sql.startsWith('UPDATE user_company SET')) return { affectedRows: 1 };
      return [{ balance: 100000 }];
    });
    (svc as any).dataSource = { manager: { query } };

    await expect((svc as any).refundBalance(makeAccount({ isCompany: true }).user, 30000)).resolves.toEqual({
      beforeBalance: 70000,
      afterBalance: 100000,
      balanceManagementType: 'COMPANY',
    });
  });
});

describe('resendOrder — R3 가드', () => {
  function resendService(order: OrderEntity, orderDelivery: Partial<OrderDeliveryEntity>) {
    const svc = Object.create(ExternalApiService.prototype) as ExternalApiService;
    // §9 컷오버 게이트 — 단위 테스트 기본값은 '미전환 건'(legacy 경로 그대로 통과).
    (svc as any).cutoverGuard = {
      assertLegacyAllowed: jest.fn().mockResolvedValue(undefined),
      assertRefundExecutionAllowed: jest.fn().mockResolvedValue(undefined),
      isCutover: jest.fn().mockResolvedValue(false),
      splitLegacyAllowed: jest.fn(async (ids: number[]) => ({ allowed: ids, blocked: [] })),
    };
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
      // 발송결과 targeted update 는 fencing(affected 검사) + lease 해제에 쓰인다 → UpdateResult 형태로 반환
      update: jest.fn(async () => ({ affected: 1 })),
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

// ── 리뷰 HIGH: processCancelRefund 상태 쓰기의 D3-60 clobber 제거 + 변형 lease fencing ──
describe('processCancelRefund — 상태 쓰기 fencing (리뷰 HIGH)', () => {
  it('full save 를 쓰지 않는다 — 행 전체 merge 로 남의 컬럼을 되돌리면 안 된다 (D3-60)', async () => {
    const { svc, mocks } = refundService({ isWalletManaged: false });

    await (svc as any).processCancelRefund(makeOrder(), makeOrderDelivery(), makeAccount(), LEASE_TOKEN);

    // save(orderDelivery) 는 merge 라 재조회하지 않은 컬럼(imagePath·deletedAt·reportState…)까지
    // 스냅샷 값으로 되돌린다. 이 경로는 targeted update 만 써야 한다.
    expect(mocks.odSave).not.toHaveBeenCalled();
    expect(mocks.odUpdate).toHaveBeenCalledTimes(1);
  });

  it('이 함수가 바꾸는 3개 컬럼만 쓴다 (status/couponStatus/discardedAt)', async () => {
    const { svc, mocks } = refundService({ isWalletManaged: false });

    await (svc as any).processCancelRefund(makeOrder(), makeOrderDelivery(), makeAccount(), LEASE_TOKEN);

    const [, patch] = mocks.odUpdate.mock.calls[0] as any[];
    expect(Object.keys(patch).sort()).toEqual(['couponStatus', 'discardedAt', 'status']);
  });

  it('where 조건에 내 lease 토큰이 실린다 — 뺏긴 뒤엔 안 써야 하므로', async () => {
    const { svc, mocks } = refundService({ isWalletManaged: false });

    await (svc as any).processCancelRefund(makeOrder(), makeOrderDelivery(), makeAccount(), LEASE_TOKEN);

    const [where] = mocks.odUpdate.mock.calls[0] as any[];
    expect(where).toEqual({ id: 55, mutationClaimedAt: LEASE_TOKEN });
  });

  it('lease 를 뺏겨 affected=0 이어도 환불은 집행한다 — 협력사 취소가 이미 끝난 비가역 작업이므로', async () => {
    // ★ 중단하면 "협력사 쿠폰은 죽었는데 환불은 안 나간" 고객 피해가 남는다.
    //   cancelByExternalApi 는 cancelOrder 에서 이 함수보다 **먼저** 호출된다.
    const { svc, mocks } = refundService({ isWalletManaged: false, updateAffected: 0 });

    await expect(
      (svc as any).processCancelRefund(makeOrder(), makeOrderDelivery(), makeAccount(), LEASE_TOKEN),
    ).resolves.toBeUndefined();

    expect(mocks.refundBalance).toHaveBeenCalledWith(expect.anything(), 30000);
  });

  it('lease 상실은 조용히 넘어가지 않는다 — [CANCEL_FENCE_LOST] 경보로 수동 정합 유도', async () => {
    const { svc, mocks } = refundService({ isWalletManaged: false, updateAffected: 0 });

    await (svc as any).processCancelRefund(makeOrder(), makeOrderDelivery(), makeAccount(), LEASE_TOKEN);

    expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('[CANCEL_FENCE_LOST]'));
  });

  it('정상 소유(affected=1)면 경보를 남기지 않는다 — 오탐 방지', async () => {
    const { svc, mocks } = refundService({ isWalletManaged: false });

    await (svc as any).processCancelRefund(makeOrder(), makeOrderDelivery(), makeAccount(), LEASE_TOKEN);

    expect(mocks.logger.error).not.toHaveBeenCalledWith(expect.stringContaining('[CANCEL_FENCE_LOST]'));
  });
});

describe('cancelOrder — 동시 취소 mutation lease 방어', () => {
  it('lease 획득 실패 시 협력사 취소와 환불로 내려가지 않는다', async () => {
    const svc = Object.create(ExternalApiService.prototype) as ExternalApiService;
    // §9 컷오버 게이트 — 단위 테스트 기본값은 '미전환 건'(legacy 경로 그대로 통과).
    (svc as any).cutoverGuard = {
      assertLegacyAllowed: jest.fn().mockResolvedValue(undefined),
      assertRefundExecutionAllowed: jest.fn().mockResolvedValue(undefined),
      isCutover: jest.fn().mockResolvedValue(false),
      splitLegacyAllowed: jest.fn(async (ids: number[]) => ({ allowed: ids, blocked: [] })),
    };
    const order = makeOrder();
    const product = { isCancelable: true, partnerCompany: { id: 77 } };
    const orderDelivery = makeOrderDelivery({
      orderProductMapping: { order, product },
    } as any);
    const cancelByExternalApi = jest.fn(async () => undefined);
    const processCancelRefund = jest.fn(async () => undefined);
    const releaseMutationLease = jest.fn(async () => undefined);

    (svc as any).findOrderDeliveryByTrId = jest.fn(async () => orderDelivery);
    (svc as any).acquireMutationLease = jest.fn(async () => false);
    (svc as any).releaseMutationLease = releaseMutationLease;
    (svc as any).partnerCompanyExternService = { cancelByExternalApi };
    (svc as any).processCancelRefund = processCancelRefund;

    await expect((svc as any).cancelOrder(makeAccount(), 'TR-1', {})).rejects.toMatchObject({
      code: '3010',
    });

    expect(cancelByExternalApi).not.toHaveBeenCalled();
    expect(processCancelRefund).not.toHaveBeenCalled();
    expect(releaseMutationLease).not.toHaveBeenCalled();
  });
});

// ── phaseC 가 "유일하게 영속하는 컬럼" 잠금 ──────────────────────────────
//
// phaseC 는 현재 save(orderDelivery)(=merge, 행 전체)로 영속한다. 이를 targeted update 로
// 좁히려면 **phaseC 말고는 아무도 안 쓰는 컬럼**을 하나도 빠짐없이 열거해야 한다.
// 하나라도 빠지면 드문 clobber 를 막으려다 **매 주문 확정 유실**을 만든다.
//
//   expireAt   — phaseB 에서 issue() **뒤**에 계산된다. persistIssuedPin 은 이미 지나간 뒤라
//                그 값을 모른다. phaseC 가 유일한 영속자.
//   imagePath  — 쿠폰 이미지. 자체 update 가 없다. 빠지면 이미지가 영영 유실된다.
//   report 4종 — 알림톡 POST 성공 표식. 빠지면 sweep 이 재선택해 **중복 발송**한다.
//   status/actualSendAt/failedAt/apiErrorMessage — 발송 결과 그 자체.
//
// 아래 헬퍼는 save(entity) 든 update(where, patch) 든 **구현과 무관하게** 반영 컬럼을 모은다.
// → save→targeted update 리팩터 전후로 **같은 단언**이 성립한다(리팩터 가드).
function persistedColumns(mocks: { odSave: jest.Mock; odUpdate: jest.Mock }): Set<string> {
  const cols = new Set<string>();
  for (const call of mocks.odSave.mock.calls as unknown as any[][]) {
    Object.keys(call[0] ?? {}).forEach((k) => cols.add(k));
  }
  for (const call of mocks.odUpdate.mock.calls as unknown as any[][]) {
    Object.keys(call[1] ?? {}).forEach((k) => cols.add(k));
  }
  return cols;
}

/** phaseB 를 막 통과한 알림톡 주문의 delivery — phaseC 가 영속해야 할 값이 전부 실려 있다. */
const makePostSendDelivery = () =>
  makeOrderDelivery({
    status: 'COMPLETE',
    actualSendAt: new Date('2026-07-24T01:00:00.000Z'),
    failedAt: null,
    expireAt: new Date('2026-08-23T00:00:00.000Z'),
    imagePath: 'img/coupon-55.png',
    alimTalkMsgKey: 'MSG-KEY-1',
    reportState: 'PENDING',
    reportNextDueAt: new Date('2026-07-24T01:05:00.000Z'),
    reportDeadlineAt: new Date('2026-07-24T02:00:00.000Z'),
    apiErrorMessage: null,
  } as any);

const PHASEC_REQUIRED_COLUMNS = [
  'status',
  'actualSendAt',
  'failedAt',
  'expireAt',
  'imagePath',
  'alimTalkMsgKey',
  'reportState',
  'reportNextDueAt',
  'reportDeadlineAt',
];

describe('phaseC — 영속 컬럼 집합 잠금 (save→targeted update 리팩터 가드)', () => {
  it('성공 경로: phaseC 가 유일 영속자인 컬럼이 전부 DB 에 반영된다', async () => {
    const { svc, mocks } = refundService({ isWalletManaged: false });

    await (svc as any).phaseC_handleSuccess(makeOrder(), makePostSendDelivery());

    const cols = persistedColumns(mocks);
    for (const required of PHASEC_REQUIRED_COLUMNS) {
      // 실패하면 = 그 컬럼이 DB 에 안 실린다 = 유실. imagePath 면 쿠폰 이미지가,
      // reportState 면 알림톡 중복 발송이 된다.
      expect(cols.has(required)).toBe(true);
    }
  });

  it('실패 경로: 위 컬럼 + apiErrorMessage 가 DB 에 반영된다', async () => {
    const { svc, mocks } = refundService({ isWalletManaged: false });

    await (svc as any).phaseC_handleFailure(makeOrder(), makePostSendDelivery(), makeAccount(), new Error('발송 실패'));

    const cols = persistedColumns(mocks);
    for (const required of [...PHASEC_REQUIRED_COLUMNS, 'apiErrorMessage']) {
      expect(cols.has(required)).toBe(true);
    }
  });
});

// ── phaseC clobber 부재 회귀 (D3-60) ────────────────────────────────────
describe('phaseC — full save() 부재 (D3-60 clobber)', () => {
  it('성공 경로: save() 를 쓰지 않는다 — targeted update 로만 영속', async () => {
    const { svc, mocks } = refundService({ isWalletManaged: false });

    await (svc as any).phaseC_handleSuccess(makeOrder(), makePostSendDelivery());

    expect(mocks.odSave).not.toHaveBeenCalled();
    expect(mocks.odUpdate).toHaveBeenCalledTimes(1);
  });

  it('실패 경로: save() 를 쓰지 않는다', async () => {
    const { svc, mocks } = refundService({ isWalletManaged: false });

    await (svc as any).phaseC_handleFailure(makeOrder(), makePostSendDelivery(), makeAccount(), new Error('x'));

    expect(mocks.odSave).not.toHaveBeenCalled();
    expect(mocks.odUpdate).toHaveBeenCalledTimes(1);
  });

  it('SET 절에 clobber 3컬럼이 없다 — 남이 확정한 값을 되돌리지 않는다', async () => {
    const { svc, mocks } = refundService({ isWalletManaged: false });

    await (svc as any).phaseC_handleSuccess(makeOrder(), makePostSendDelivery());

    const [, patch] = mocks.odUpdate.mock.calls[0] as any[];
    expect(patch).not.toHaveProperty('couponStatus'); // 환불된 쿠폰 되살림
    expect(patch).not.toHaveProperty('deletedAt'); // 지워진 행 부활
    expect(patch).not.toHaveProperty('mutationClaimedAt'); // CS 폐기가 쥔 lease 무력화
  });

  it('발급 결과 컬럼은 건드리지 않는다 — persistIssuedPin 소관 (이중 소유 금지)', async () => {
    const { svc, mocks } = refundService({ isWalletManaged: false });

    await (svc as any).phaseC_handleSuccess(makeOrder(), makePostSendDelivery());

    const [, patch] = mocks.odUpdate.mock.calls[0] as any[];
    for (const owned of ['barCode', 'personalCode', 'couponNum', 'ssgTransactionId', 'ssgEventId']) {
      expect(patch).not.toHaveProperty(owned);
    }
    // transactionId/externalTrId 는 saveTransactionIds 소관
    expect(patch).not.toHaveProperty('transactionId');
    expect(patch).not.toHaveProperty('externalTrId');
  });
});
// ── 재조정 증거 바인딩: attempt ↔ 실제 금전 부작용 (리뷰 P2) ────────────────
describe('inspectExternalCancelRefund — 환불 증거 바인딩', () => {
  const ATTEMPT = { id: '31', amount: 30000 };

  function inspectService(opts: {
    isWalletManaged: boolean;
    events?: Array<Partial<OrderPaymentRefundEventEntity>>;
    transaction?: Partial<WalletTransactionEntity> | null;
  }) {
    const svc = Object.create(ExternalApiService.prototype) as ExternalApiService;
    const eventConditions: Array<{ sql: string; params?: Record<string, unknown> }> = [];
    const eventBuilder: any = {
      where: jest.fn((sql: string, params?: Record<string, unknown>) => {
        eventConditions.push({ sql, params });
        return eventBuilder;
      }),
      andWhere: jest.fn((sql: string, params?: Record<string, unknown>) => {
        eventConditions.push({ sql, params });
        return eventBuilder;
      }),
      getMany: jest.fn(async () => opts.events ?? []),
    };
    const transactionFindOne = jest.fn(async () => opts.transaction ?? null);
    (svc as any).dataSource = {
      manager: {
        getRepository: jest.fn((entity: any) =>
          entity === WalletTransactionEntity
            ? { findOne: transactionFindOne }
            : { createQueryBuilder: jest.fn(() => eventBuilder) },
        ),
      },
    };
    (svc as any).refundLedgerService = {
      findByAttempt: jest.fn(async () => ({ id: 991, sourcePath: 'EXTERNAL_CANCEL', ssgBalanceSettled: true })),
    };
    (svc as any).walletManagedPredicate = {
      isWalletManaged: jest.fn(async () => opts.isWalletManaged),
    };
    (svc as any).loadOrderBillingUser = jest.fn(async () => makeAccount().user);
    const refundViaWallet = jest.fn(async () => undefined);
    const refundLegacyBalanceAndAudit = jest.fn(async () => undefined);
    (svc as any).refundViaWallet = refundViaWallet;
    (svc as any).refundLegacyBalanceAndAudit = refundLegacyBalanceAndAudit;

    const inspect = () =>
      (svc as any).inspectExternalCancelRefund(ATTEMPT, makeOrder(), makeOrderDelivery(), makeAccount());
    return { svc, inspect, eventConditions, transactionFindOne, refundViaWallet, refundLegacyBalanceAndAudit };
  }

  it('wallet 증거는 이 delivery 의 멱등키 prefix 로 좁힌다 — 과거의 다른 환불 이벤트가 통과하면 안 된다', async () => {
    const { inspect, eventConditions } = inspectService({
      isWalletManaged: true,
      events: [{ refundedGrossBase: 30000, refundedCardSurchargeAmount: 0 }],
    });

    await inspect();

    expect(eventConditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sql: 'event.idempotency_key LIKE :prefix',
          params: { prefix: 'discard_refund:1:55:%' },
        }),
      ]),
    );
  });

  it('prefix 가 일치하는 증거가 없으면 wallet 환불을 실행한다', async () => {
    const { inspect, refundViaWallet } = inspectService({ isWalletManaged: true, events: [] });

    const result = await inspect();

    expect(refundViaWallet).toHaveBeenCalled();
    expect(result).toEqual({ status: RefundAttemptStatus.SUCCEEDED });
  });

  it('wallet 증거 금액이 attempt 환불액과 다르면 성공으로 확정하지 않는다', async () => {
    const { inspect, refundViaWallet } = inspectService({
      isWalletManaged: true,
      events: [{ refundedGrossBase: 10000, refundedCardSurchargeAmount: 0 }],
    });

    await expect(inspect()).rejects.toThrow(/refund evidence amount mismatch/);
    expect(refundViaWallet).not.toHaveBeenCalled();
  });

  it('legacy 증거는 정확한 멱등키로만 조회한다', async () => {
    const { inspect, transactionFindOne } = inspectService({
      isWalletManaged: false,
      transaction: { amount: 30000 },
    });

    await inspect();

    expect(transactionFindOne).toHaveBeenCalledWith({
      where: {
        idempotencyKey: 'legacy_discard_refund:1:55:deposit',
        orderDeliveryId: 55,
        type: 'DISCARD_REFUND',
      },
    });
  });

  it('legacy 증거가 없으면 환불을 실행하고, 금액이 다르면 확정하지 않는다', async () => {
    const missing = inspectService({ isWalletManaged: false, transaction: null });
    await missing.inspect();
    expect(missing.refundLegacyBalanceAndAudit).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'legacy_discard_refund:1:55:deposit' }),
    );

    const mismatched = inspectService({ isWalletManaged: false, transaction: { amount: 25000 } });
    await expect(mismatched.inspect()).rejects.toThrow(/refund evidence amount mismatch/);
    expect(mismatched.refundLegacyBalanceAndAudit).not.toHaveBeenCalled();
  });
});
