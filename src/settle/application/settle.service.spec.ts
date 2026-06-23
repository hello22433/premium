import { BadRequestException } from '@nestjs/common';
import { SettleService } from './settle.service';

jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: any, _key: string, descriptor: PropertyDescriptor) => descriptor,
  Propagation: { REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSource: jest.fn(),
}));

function makeService(overrides: Record<string, any> = {}): any {
  const svc = Object.create(SettleService.prototype);
  Object.assign(svc, {
    orderRepository: { createQueryBuilder: jest.fn(), manager: {} },
    userRepository: { findOne: jest.fn(), createQueryBuilder: jest.fn() },
    orderDeliveryRepository: { find: jest.fn().mockResolvedValue([]) },
    walletManagedPredicate: { isWalletManaged: jest.fn().mockResolvedValue(false) },
    settleConfirmationWalletService: { confirmSettlement: jest.fn() },
    legacyWalletCreditSyncService: { syncCredit: jest.fn() },
    ...overrides,
  });
  return svc;
}

describe('SettleService — confirmSingleOrderTx (#20 fix)', () => {
  const ORDER_ID = 42;

  function makeOrderQb(order: object | null) {
    const qb: any = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(order),
    };
    return qb;
  }

  function makeAtomicUpdateQb(affected = 1) {
    return {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected }),
    } as any;
  }

  function makeUserCqb() {
    return {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    } as any;
  }

  it('lock 후 getOrderSettlementSummary 를 재호출하며 fresh netAmount 를 settledAmountSnapshot 에 저장한다', async () => {
    const order = { id: ORDER_ID, settleStatus: null, clientUserId: null, userId: 7, isSettleBalance: false };
    const atomicQb = makeAtomicUpdateQb(1);

    const svc = makeService({
      orderRepository: {
        createQueryBuilder: jest.fn()
          .mockReturnValueOnce(makeOrderQb(order))
          .mockReturnValueOnce(atomicQb),
        manager: {},
      },
      userRepository: {
        findOne: jest.fn().mockResolvedValue({ id: 7 }),
        createQueryBuilder: jest.fn().mockReturnValue(makeUserCqb()),
      },
    });

    const summarySpy = jest
      .spyOn(svc, 'getOrderSettlementSummary')
      .mockResolvedValue(new Map([[ORDER_ID, { netAmount: 7_000, hasPending: false }]]));

    // stale 10000 전달 — fix 없으면 이 값이 snapshot 에 저장됨
    await (svc as any).confirmSingleOrderTx(ORDER_ID, { netAmount: 10_000, hasPending: false });

    expect(summarySpy).toHaveBeenCalledTimes(1);
    expect(summarySpy).toHaveBeenCalledWith([ORDER_ID]);
    expect(atomicQb.set).toHaveBeenCalledWith(
      expect.objectContaining({ settledAmountSnapshot: 7_000 }),
    );
    expect(atomicQb.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ settledAmountSnapshot: 10_000 }),
    );
  });

  it('allSettleAmount 차감에도 stale(10000) 아닌 fresh(7000) 가 전달된다', async () => {
    const order = { id: ORDER_ID, settleStatus: null, clientUserId: null, userId: 7, isSettleBalance: false };
    const atomicQb = makeAtomicUpdateQb(1);
    const userCqb = makeUserCqb();

    const svc = makeService({
      orderRepository: {
        createQueryBuilder: jest.fn()
          .mockReturnValueOnce(makeOrderQb(order))
          .mockReturnValueOnce(atomicQb),
        manager: {},
      },
      userRepository: {
        findOne: jest.fn().mockResolvedValue({ id: 7 }),
        createQueryBuilder: jest.fn().mockReturnValue(userCqb),
      },
    });

    jest.spyOn(svc, 'getOrderSettlementSummary').mockResolvedValue(
      new Map([[ORDER_ID, { netAmount: 7_000, hasPending: false }]]),
    );

    await (svc as any).confirmSingleOrderTx(ORDER_ID, { netAmount: 10_000, hasPending: false });

    expect(userCqb.setParameters).toHaveBeenCalledWith({ amount: 7_000 });
    expect(userCqb.setParameters).not.toHaveBeenCalledWith({ amount: 10_000 });
    // 레거시 정산확정 → wallet credit_used SETTLE_RELEASE(-fresh netAmount) 동기화
    expect((svc as any).legacyWalletCreditSyncService.syncCredit).toHaveBeenCalledWith(
      (svc as any).orderRepository.manager,
      expect.objectContaining({ billingUserId: 7, orderId: ORDER_ID, delta: -7_000, type: 'SETTLE_RELEASE' }),
    );
  });

  it('레거시 정산해제(PRE_PAYMENT)는 wallet credit_used 를 SETTLE_UNDO(+snapshot) 로 동기화한다', async () => {
    const order = {
      id: ORDER_ID, settleStatus: 'SETTLE_COMPLETE', clientUserId: null, userId: 7,
      isSettleBalance: false, isSettleComplete: true, settledAmountSnapshot: 7_000,
    };
    const lockQb = makeOrderQb(order);
    const updateQb = makeAtomicUpdateQb(1);
    const svc = makeService({
      orderRepository: {
        createQueryBuilder: jest.fn().mockReturnValueOnce(lockQb).mockReturnValueOnce(updateQb),
        manager: { __undo: true },
      },
      userRepository: {
        findOne: jest.fn().mockResolvedValue({ id: 7, settleCondition: 'PRE_PAYMENT' }),
        createQueryBuilder: jest.fn().mockReturnValue(makeUserCqb()),
      },
    });
    jest.spyOn(svc, 'getSettledDiscardRestoreAmount').mockResolvedValue(0);

    await (svc as any).updateUserPerOrder({ orderId: ORDER_ID, settleStatus: 'UNSETTLE_NORMAL' });

    expect((svc as any).legacyWalletCreditSyncService.syncCredit).toHaveBeenCalledWith(
      (svc as any).orderRepository.manager,
      expect.objectContaining({ billingUserId: 7, orderId: ORDER_ID, delta: 7_000, type: 'SETTLE_UNDO' }),
    );
  });

  it('hasPending=true 이면 재계산 없이 400 을 던진다', async () => {
    const order = { id: ORDER_ID, settleStatus: null, clientUserId: null, userId: 7, isSettleBalance: false };

    const svc = makeService({
      orderRepository: {
        createQueryBuilder: jest.fn().mockReturnValue(makeOrderQb(order)),
        manager: {},
      },
      userRepository: { findOne: jest.fn().mockResolvedValue({ id: 7 }) },
    });

    const summarySpy = jest.spyOn(svc, 'getOrderSettlementSummary');

    await expect(
      (svc as any).confirmSingleOrderTx(ORDER_ID, { netAmount: 5_000, hasPending: true }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // hasPending 차단은 재계산 전 — spy 호출 없어야 함
    expect(summarySpy).not.toHaveBeenCalled();
  });

  it('SETTLE_COMPLETE 주문은 재계산 없이 skipped 를 반환한다', async () => {
    const order = { id: ORDER_ID, settleStatus: 'SETTLE_COMPLETE', clientUserId: null, userId: 7 };

    const svc = makeService({
      orderRepository: {
        createQueryBuilder: jest.fn().mockReturnValue(makeOrderQb(order)),
        manager: {},
      },
    });

    const summarySpy = jest.spyOn(svc, 'getOrderSettlementSummary');

    const result = await (svc as any).confirmSingleOrderTx(ORDER_ID, { netAmount: 5_000, hasPending: false });

    expect(result).toBe('skipped');
    expect(summarySpy).not.toHaveBeenCalled();
  });

  it('프리로드 시점 hasPending=false 였어도 lock 후 재계산에서 hasPending=true 면 400 을 던진다', async () => {
    const order = { id: ORDER_ID, settleStatus: null, clientUserId: null, userId: 7, isSettleBalance: false };

    const svc = makeService({
      orderRepository: {
        createQueryBuilder: jest.fn().mockReturnValue(makeOrderQb(order)),
        manager: {},
      },
      userRepository: {
        findOne: jest.fn().mockResolvedValue({ id: 7 }),
        createQueryBuilder: jest.fn(),
      },
    });

    jest.spyOn(svc, 'getOrderSettlementSummary').mockResolvedValue(
      new Map([[ORDER_ID, { netAmount: 5_000, hasPending: true }]]),
    );

    await expect(
      (svc as any).confirmSingleOrderTx(ORDER_ID, { netAmount: 5_000, hasPending: false }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
