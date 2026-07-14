import { CustomerServiceService } from './customer.service.service';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { OrderDeliveryAttemptType } from '../../entity/order.delivery.attempt.entity';
import { applyCardSurcharge } from '../../order/domain/order.fee.calculator';
import { IProductType } from '../../product/interface/product.type';
import { UserTaskHistoryEntity } from '../../entity/user.task.history.entity';

/**
 * PR-A — refunded-proxy reader 정규화.
 * restoreBalanceOnDiscard 의 skip 판단을 status===FAIL 프록시에서 financial SoT(refund ledger exists)로 전환.
 *
 * Acceptance (no-op 아님):
 *   FAIL + exists=true      → skip (동일)
 *   COMPLETE + exists=true  → skip (이중 복구 방지, 개선)
 *   FAIL + exists=false     → restore 수행 (보류/orphan 의도적 동작 변경)
 *
 * 생성자 의존성이 많아 Object.create 로 생성자 우회 후 메서드만 격리 테스트한다.
 */
describe('CustomerServiceService.restoreBalanceOnDiscard — refunded-proxy reader (PR-A)', () => {
  const buildOrderDelivery = (status: IOrderDeliveryStatus) =>
    ({
      id: 5001,
      status,
      couponStatus: null,
      deliveryTarget: 'enc',
      orderProductMapping: {
        fee: null,
        priceAdjustment: null,
        product: { price: 10000 },
        order: {
          id: 700,
          clientUserId: null,
          userId: 5,
          isSettleComplete: false,
          isSettleBalance: false,
          cardSurchargeApplied: false,
        },
      },
    }) as any;

  const operator = { id: 9, email: 'op@enmad.com' } as any;

  const makeSut = (existsResult: boolean, claimImpl?: jest.Mock) => {
    const sut: any = Object.create(CustomerServiceService.prototype);
    sut.refundLedgerService = {
      exists: jest.fn().mockResolvedValue(existsResult),
      claimWithManager: claimImpl ?? jest.fn().mockResolvedValue(undefined),
    };
    sut.walletManagedPredicate = { isWalletManaged: jest.fn().mockResolvedValue(false) };
    sut.legacyWalletCreditSyncService = { syncCredit: jest.fn(), syncDeposit: jest.fn() };
    return sut;
  };

  const queryRunnerWithUser = () =>
    ({
      manager: { findOne: jest.fn().mockResolvedValue({ id: 5, company: null }) },
    }) as any;

  it('FAIL + exists=true → skip (claimWithManager 미호출)', async () => {
    const sut = makeSut(true);
    await sut.restoreBalanceOnDiscard(buildOrderDelivery(IOrderDeliveryStatus.FAIL), operator, {} as any);
    expect(sut.refundLedgerService.exists).toHaveBeenCalledWith(5001);
    expect(sut.refundLedgerService.claimWithManager).not.toHaveBeenCalled();
  });

  it('COMPLETE + exists=true → skip (이중 복구 방지)', async () => {
    const sut = makeSut(true);
    await sut.restoreBalanceOnDiscard(buildOrderDelivery(IOrderDeliveryStatus.COMPLETE), operator, {} as any);
    expect(sut.refundLedgerService.claimWithManager).not.toHaveBeenCalled();
  });

  it('FAIL + exists=false (보류/orphan) → restore 수행 (claimWithManager 도달)', async () => {
    const claim = jest.fn().mockRejectedValue(new Error('REACHED_RESTORE'));
    const sut = makeSut(false, claim);

    await expect(
      sut.restoreBalanceOnDiscard(buildOrderDelivery(IOrderDeliveryStatus.FAIL), operator, queryRunnerWithUser()),
    ).rejects.toThrow(/REACHED_RESTORE/);

    // status===FAIL 이어도 ledger 없으면 skip 하지 않고 복구 경로(claim)로 진입
    expect(claim).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orderDeliveryId: 5001, sourcePath: 'CS_DISCARD' }),
    );
  });

  const legacyDiscardQueryRunner = () => {
    const builder: any = {
      update: () => builder,
      set: () => builder,
      where: () => builder,
      setParameters: () => builder,
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    return {
      manager: {
        findOne: jest.fn().mockResolvedValue({ id: 5, company: null, allSettleAmount: 0, balance: 0 }),
        createQueryBuilder: jest.fn(() => builder),
        save: jest.fn().mockResolvedValue(undefined),
      },
    } as any;
  };

  it('레거시 미정산 폐기 복구는 wallet credit_used 를 DISCARD_REFUND(-restore) 로 동기화한다', async () => {
    const sut: any = makeSut(false); // exists=false → 복구 진행, isWalletManaged=false
    sut.activityLogService = { createLog: jest.fn().mockResolvedValue(undefined) };
    sut.cryptoCipher = {
      safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01000000000'),
      encryptDeliveryTarget: jest.fn((v: string) => v),
    };

    await sut.restoreBalanceOnDiscard(
      buildOrderDelivery(IOrderDeliveryStatus.FAIL),
      operator,
      legacyDiscardQueryRunner(),
      'operator',
    );

    expect(sut.legacyWalletCreditSyncService.syncCredit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        billingUserId: 5,
        orderId: 700,
        orderDeliveryId: 5001,
        delta: -10000,
        type: 'DISCARD_REFUND',
      }),
    );
  });

  it('wallet-managed 미정산 폐기 복구는 legacy syncCredit 을 호출하지 않는다 (이중차감 방지)', async () => {
    const sut: any = makeSut(false);
    sut.walletManagedPredicate = { isWalletManaged: jest.fn().mockResolvedValue(true) };
    sut.activityLogService = { createLog: jest.fn().mockResolvedValue(undefined) };
    sut.cryptoCipher = {
      safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01000000000'),
      encryptDeliveryTarget: jest.fn((v: string) => v),
    };
    sut.refundPoolService = { refund: jest.fn().mockResolvedValue({ ledgerIds: [], totalRefundedAmount: 0 }) };

    await sut.restoreBalanceOnDiscard(
      buildOrderDelivery(IOrderDeliveryStatus.FAIL),
      operator,
      legacyDiscardQueryRunner(),
      'operator',
    );

    expect(sut.legacyWalletCreditSyncService.syncCredit).not.toHaveBeenCalled();
  });

  it('레거시 선입금환불(isSettleBalance) 폐기 복구는 wallet deposit 을 DISCARD_REFUND(+restore) 로 동기화한다', async () => {
    const sut: any = makeSut(false); // exists=false → 복구 진행, isWalletManaged=false
    sut.activityLogService = { createLog: jest.fn().mockResolvedValue(undefined) };
    sut.cryptoCipher = {
      safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01000000000'),
      encryptDeliveryTarget: jest.fn((v: string) => v),
    };

    const orderDelivery = buildOrderDelivery(IOrderDeliveryStatus.COMPLETE);
    orderDelivery.orderProductMapping.order.isSettleBalance = true;

    await sut.restoreBalanceOnDiscard(orderDelivery, operator, legacyDiscardQueryRunner(), 'operator');

    expect(sut.legacyWalletCreditSyncService.syncDeposit).toHaveBeenCalledTimes(1);
    expect(sut.legacyWalletCreditSyncService.syncDeposit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        billingUserId: 5,
        orderId: 700,
        orderDeliveryId: 5001,
        delta: 10000,
        type: 'DISCARD_REFUND',
        idempotencyKey: 'legacy_discard_refund:700:5001:deposit',
      }),
    );
    // 여신(syncCredit) 경로는 선입금환불에서 호출되지 않는다.
    expect(sut.legacyWalletCreditSyncService.syncCredit).not.toHaveBeenCalled();
  });

  it('wallet-managed 선입금환불 폐기 복구는 legacy syncDeposit 을 호출하지 않는다 (이중반영 방지)', async () => {
    const sut: any = makeSut(false);
    const latestAttempt = { id: '44', attemptType: OrderDeliveryAttemptType.RESEND };
    const user = { id: 5, email: 'buyer@test.local', balance: 0, company: null };
    const builder: any = {
      update: () => builder,
      set: () => builder,
      where: () => builder,
      setParameters: () => builder,
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const queryRunner = {
      manager: {
        findOne: jest.fn(async (_target: any, opts: any) => {
          if (opts?.where?.orderDeliveryId === 5001) return latestAttempt;
          return user;
        }),
        createQueryBuilder: jest.fn(() => builder),
        save: jest.fn().mockResolvedValue(undefined),
      },
    } as any;
    sut.activityLogService = { createLog: jest.fn().mockResolvedValue(undefined) };
    sut.cryptoCipher = {
      safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01012345678'),
      encryptDeliveryTarget: jest.fn((v: string) => v),
    };
    sut.walletManagedPredicate = { isWalletManaged: jest.fn().mockResolvedValue(true) };
    sut.refundPoolService = { refund: jest.fn().mockResolvedValue({ ledgerIds: [], totalRefundedAmount: 0 }) };

    const orderDelivery = buildOrderDelivery(IOrderDeliveryStatus.COMPLETE);
    orderDelivery.orderProductMapping.order.isSettleBalance = true;

    await sut.restoreBalanceOnDiscard(orderDelivery, operator, queryRunner, 'operator');

    expect(sut.legacyWalletCreditSyncService.syncDeposit).not.toHaveBeenCalled();
  });

  it('wallet 정산완료 폐기 환불은 INITIAL 고정이 아니라 최신 attempt.id 로 멱등키를 만든다', async () => {
    const sut: any = makeSut(false);
    const latestAttempt = { id: '44', attemptType: OrderDeliveryAttemptType.RESEND };
    const user = { id: 5, email: 'buyer@test.local', company: null };
    const queryRunner = {
      manager: {
        findOne: jest.fn(async (_target: any, opts: any) => {
          if (opts?.where?.orderDeliveryId === 5001) return latestAttempt;
          return user;
        }),
        createQueryBuilder: jest.fn(() => {
          const builder: any = {
            update: () => builder,
            set: () => builder,
            where: () => builder,
            setParameters: () => builder,
            execute: jest.fn().mockResolvedValue({ affected: 1 }),
          };
          return builder;
        }),
        save: jest.fn().mockResolvedValue(undefined),
      },
    } as any;
    sut.activityLogService = { createLog: jest.fn().mockResolvedValue(undefined) };
    sut.cryptoCipher = {
      safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01012345678'),
      encryptDeliveryTarget: jest.fn((v: string) => v),
    };
    sut.walletManagedPredicate = { isWalletManaged: jest.fn().mockResolvedValue(true) };
    sut.refundPoolService = {
      refundSettledDiscardToDeposit: jest.fn().mockResolvedValue({ ledgerIds: ['1'], totalRefundedAmount: 10000 }),
    };

    const orderDelivery = buildOrderDelivery(IOrderDeliveryStatus.COMPLETE);
    orderDelivery.orderProductMapping.order.isSettleComplete = true;

    await sut.restoreBalanceOnDiscard(orderDelivery, operator, queryRunner, 'operator');

    const attemptLookup = queryRunner.manager.findOne.mock.calls.find(
      ([, opts]: [unknown, any]) => opts?.where?.orderDeliveryId === 5001,
    );
    expect(attemptLookup?.[1].where).toEqual({ orderDeliveryId: 5001 });
    expect(sut.refundPoolService.refundSettledDiscardToDeposit).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKeyPrefix: 'discard_refund:700:5001:deposit:44',
      }),
      queryRunner.manager,
    );
  });

  it('wallet 정산완료 폐기 환불은 만료 포인트 제외 후 실제 wallet 복구액으로 고객사 ledger를 기록한다', async () => {
    const claim = jest.fn().mockResolvedValue(undefined);
    const sut: any = makeSut(false, claim);
    const latestAttempt = { id: '44', attemptType: OrderDeliveryAttemptType.RESEND };
    const user = { id: 5, email: 'buyer@test.local', balance: 7000, company: null };
    const builder: any = {
      update: jest.fn(() => builder),
      set: jest.fn(() => builder),
      where: jest.fn(() => builder),
      setParameters: jest.fn(() => builder),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const queryRunner = {
      manager: {
        findOne: jest.fn(async (_target: any, opts: any) => {
          if (opts?.where?.orderDeliveryId === 5001) return latestAttempt;
          return user;
        }),
        createQueryBuilder: jest.fn(() => builder),
        save: jest.fn().mockResolvedValue(undefined),
      },
    } as any;
    sut.activityLogService = { createLog: jest.fn().mockResolvedValue(undefined) };
    sut.cryptoCipher = {
      safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01012345678'),
      encryptDeliveryTarget: jest.fn((v: string) => v),
    };
    sut.walletManagedPredicate = { isWalletManaged: jest.fn().mockResolvedValue(true) };
    sut.refundPoolService = {
      refundSettledDiscardToDeposit: jest.fn().mockResolvedValue({ ledgerIds: ['1'], totalRefundedAmount: 7000 }),
    };

    const orderDelivery = buildOrderDelivery(IOrderDeliveryStatus.COMPLETE);
    orderDelivery.orderProductMapping.order.isSettleComplete = true;

    await sut.restoreBalanceOnDiscard(orderDelivery, operator, queryRunner, 'operator');

    expect(claim).toHaveBeenCalledWith(
      queryRunner.manager,
      expect.objectContaining({
        orderDeliveryId: 5001,
        refundAmount: 7000,
        isSettleComplete: true,
        sourcePath: 'CS_DISCARD',
      }),
    );
    expect(builder.setParameters).toHaveBeenCalledWith({ amount: 7000 });
  });

  it('정산완료 카드할증 주문의 폐기 복구 ledger는 배송별 카드할증이 아니라 snapshot 배분 금액을 기록한다', async () => {
    const claim = jest.fn().mockResolvedValue(undefined);
    const sut: any = makeSut(false, claim);
    const user = { id: 5, email: 'buyer@test.local', balance: 0, company: null };
    const builder: any = {
      update: jest.fn(() => builder),
      set: jest.fn(() => builder),
      where: jest.fn(() => builder),
      setParameters: jest.fn(() => builder),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const queryRunner = {
      manager: {
        findOne: jest.fn().mockResolvedValue(user),
        createQueryBuilder: jest.fn(() => builder),
        save: jest.fn().mockResolvedValue(undefined),
      },
    } as any;
    sut.activityLogService = { createLog: jest.fn().mockResolvedValue(undefined) };
    sut.cryptoCipher = {
      safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01012345678'),
      encryptDeliveryTarget: jest.fn((v: string) => v),
    };

    const orderDelivery = buildOrderDelivery(IOrderDeliveryStatus.COMPLETE);
    const order = orderDelivery.orderProductMapping.order;
    order.isSettleComplete = true;
    order.cardSurchargeApplied = true;
    order.settledAmountSnapshot = applyCardSurcharge(9999 + 9999, true);

    orderDelivery.orderProductMapping.product.price = 9999;
    orderDelivery.orderProductMapping.amount = 2;
    orderDelivery.orderProductMapping.orderDeliveries = [
      orderDelivery,
      {
        id: 5002,
        status: IOrderDeliveryStatus.COMPLETE_SMS,
        couponStatus: null,
        settleFee: null,
        settlePriceAdjustment: null,
        orderProductMapping: orderDelivery.orderProductMapping,
      },
    ];

    await sut.restoreBalanceOnDiscard(orderDelivery, operator, queryRunner, 'operator');

    const expectedAllocatedAmount = Math.floor(order.settledAmountSnapshot / 2);
    expect(claim).toHaveBeenCalledWith(
      queryRunner.manager,
      expect.objectContaining({
        orderDeliveryId: 5001,
        refundAmount: expectedAllocatedAmount,
        isSettleComplete: true,
        sourcePath: 'CS_DISCARD',
      }),
    );
    expect(builder.setParameters).toHaveBeenCalledWith({ amount: expectedAllocatedAmount });
  });

  it('정산완료 카드할증 주문의 순차 폐기는 남은 snapshot을 남은 배송 base 비율로 배분한다', async () => {
    const claim = jest.fn().mockResolvedValue(undefined);
    const sut: any = makeSut(false, claim);
    const user = { id: 5, email: 'buyer@test.local', balance: 0, company: null };
    const builder: any = {
      update: jest.fn(() => builder),
      set: jest.fn(() => builder),
      where: jest.fn(() => builder),
      setParameters: jest.fn(() => builder),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const refundQb: any = {
      createQueryBuilder: jest.fn(() => refundQb),
      innerJoin: jest.fn(() => refundQb),
      select: jest.fn(() => refundQb),
      where: jest.fn(() => refundQb),
      andWhere: jest.fn(() => refundQb),
      getRawOne: jest.fn().mockResolvedValue({ totalRestore: 10300 }),
    };
    const queryRunner = {
      manager: {
        findOne: jest.fn().mockResolvedValue(user),
        createQueryBuilder: jest.fn(() => builder),
        getRepository: jest.fn(() => refundQb),
        save: jest.fn().mockResolvedValue(undefined),
      },
    } as any;
    sut.activityLogService = { createLog: jest.fn().mockResolvedValue(undefined) };
    sut.cryptoCipher = {
      safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01012345678'),
      encryptDeliveryTarget: jest.fn((v: string) => v),
    };

    const order = {
      id: 700,
      clientUserId: null,
      userId: 5,
      isSettleComplete: true,
      isSettleBalance: true,
      cardSurchargeApplied: true,
      settledAmountSnapshot: applyCardSurcharge(10000 + 20000 + 70000, true),
    };
    const makeDelivery = (id: number, baseAmount: number, couponStatus: any) => {
      const mapping = {
        fee: null,
        priceAdjustment: null,
        product: { price: baseAmount },
        amount: 1,
        order,
      };
      return {
        id,
        status: IOrderDeliveryStatus.COMPLETE,
        couponStatus,
        deliveryTarget: 'enc',
        settleFee: null,
        settlePriceAdjustment: null,
        orderProductMapping: mapping,
      } as any;
    };
    const firstDiscarded = makeDelivery(5001, 10000, 'CANCEL');
    const current = makeDelivery(5002, 20000, 'CANCEL');
    const remaining = makeDelivery(5003, 70000, null);
    current.orderProductMapping.orderDeliveries = [firstDiscarded, current, remaining];

    await sut.restoreBalanceOnDiscard(current, operator, queryRunner, 'operator');

    const expectedRestoreAmount = 20600;
    expect(claim).toHaveBeenCalledWith(
      queryRunner.manager,
      expect.objectContaining({
        orderDeliveryId: 5002,
        refundAmount: expectedRestoreAmount,
        isSettleComplete: true,
        sourcePath: 'CS_DISCARD',
      }),
    );
    expect(builder.setParameters).toHaveBeenCalledWith({ amount: expectedRestoreAmount });
  });

  it('wallet 정산완료 폐기 환불 retry는 wallet alreadyRefunded 결과로 legacy mirror를 다시 갱신하지 않는다', async () => {
    const claim = jest.fn().mockResolvedValue(undefined);
    const sut: any = makeSut(false, claim);
    const latestAttempt = { id: '44', attemptType: OrderDeliveryAttemptType.RESEND };
    const user = { id: 5, email: 'buyer@test.local', balance: 10000, company: null };
    const builder: any = {
      update: jest.fn(() => builder),
      set: jest.fn(() => builder),
      where: jest.fn(() => builder),
      setParameters: jest.fn(() => builder),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const queryRunner = {
      manager: {
        findOne: jest.fn(async (_target: any, opts: any) => {
          if (opts?.where?.orderDeliveryId === 5001) return latestAttempt;
          return user;
        }),
        createQueryBuilder: jest.fn(() => builder),
        save: jest.fn().mockResolvedValue(undefined),
      },
    } as any;
    sut.activityLogService = { createLog: jest.fn().mockResolvedValue(undefined) };
    sut.cryptoCipher = {
      safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01012345678'),
      encryptDeliveryTarget: jest.fn((v: string) => v),
    };
    sut.walletManagedPredicate = { isWalletManaged: jest.fn().mockResolvedValue(true) };
    sut.refundPoolService = {
      refundSettledDiscardToDeposit: jest.fn().mockResolvedValue({
        ledgerIds: ['1'],
        totalRefundedAmount: 10000,
        alreadyRefunded: true,
      }),
    };

    const orderDelivery = buildOrderDelivery(IOrderDeliveryStatus.COMPLETE);
    orderDelivery.orderProductMapping.order.isSettleComplete = true;

    await sut.restoreBalanceOnDiscard(orderDelivery, operator, queryRunner, 'operator');

    expect(claim).not.toHaveBeenCalled();
    expect(queryRunner.manager.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('정산완료 폐기 이력은 Tx2 복구액 확정 후 destroyAmount와 restoreAmount를 같은 snapshot 배분액으로 보강한다', async () => {
    const sut: any = Object.create(CustomerServiceService.prototype);
    const orderDelivery = buildOrderDelivery(IOrderDeliveryStatus.COMPLETE);
    orderDelivery.couponStatus = OrderDeliveryCouponStatus.NOT_USED;
    orderDelivery.orderProductMapping.product.type = IProductType.GENERAL;
    orderDelivery.orderProductMapping.product.partnerCompany = null;
    orderDelivery.orderProductMapping.product.brand = {};
    orderDelivery.orderProductMapping.order.isSettleComplete = true;
    orderDelivery.orderProductMapping.order.cardSurchargeApplied = true;
    const queryBuilder: any = {
      innerJoinAndSelect: jest.fn(() => queryBuilder),
      leftJoinAndSelect: jest.fn(() => queryBuilder),
      where: jest.fn(() => queryBuilder),
      getOne: jest.fn().mockResolvedValue(orderDelivery),
    };
    const txUpdateBuilder: any = {
      update: jest.fn(() => txUpdateBuilder),
      set: jest.fn(() => txUpdateBuilder),
      where: jest.fn(() => txUpdateBuilder),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const tx1 = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      manager: {
        createQueryBuilder: jest.fn(() => txUpdateBuilder),
        save: jest.fn().mockResolvedValue({ id: 901 }),
      },
    };
    const tx2 = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    sut.orderDeliveryRepository = { createQueryBuilder: jest.fn(() => queryBuilder) };
    sut.orderHistoryRepository = {
      create: jest.fn((input) => input),
      update: jest.fn().mockResolvedValue(undefined),
    };
    sut.dataSource = { createQueryRunner: jest.fn().mockReturnValueOnce(tx1).mockReturnValueOnce(tx2) };
    sut.authService = { authorityValidator: jest.fn().mockResolvedValue(undefined) };
    sut.restoreBalanceOnDiscard = jest.fn().mockResolvedValue(10295);

    await sut.execDiscard(operator, 5001, OrderDeliveryCouponStatus.CANCEL, { type: '폐기', content: '폐기' });

    expect(sut.orderHistoryRepository.update).toHaveBeenCalledWith(901, {
      destroyAmount: 10295,
      restoreAmount: 10295,
    });
  });

  it('couponStatus=REFUND_CANCEL → null 반환 + claimWithManager 미호출 (환불폐기 잔액 미복구 규칙)', async () => {
    // exists=false: :148 ledger 체크를 통과시켜 :152 REFUND_CANCEL 분기를 명중시킴
    // exists=true 면 :148 에서 먼저 null 반환 → REFUND_CANCEL 분기 미검증
    const sut = makeSut(false);
    const delivery = buildOrderDelivery(IOrderDeliveryStatus.COMPLETE);
    delivery.couponStatus = OrderDeliveryCouponStatus.REFUND_CANCEL;

    const result = await sut.restoreBalanceOnDiscard(delivery, operator, {} as any);

    expect(result).toBeNull();
    expect(sut.refundLedgerService.claimWithManager).not.toHaveBeenCalled();
  });
  it('여신복구(ALL_SETTLE_AMOUNT) 는 계정관리 이력관리(UserTaskHistory)에 기록하지 않는다', async () => {
    const sut: any = makeSut(false);
    sut.activityLogService = { createLog: jest.fn().mockResolvedValue(undefined) };
    sut.cryptoCipher = {
      safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01000000000'),
      encryptDeliveryTarget: jest.fn((v: string) => v),
    };
    const qr = legacyDiscardQueryRunner();

    await sut.restoreBalanceOnDiscard(buildOrderDelivery(IOrderDeliveryStatus.FAIL), operator, qr, 'operator');

    const savedTaskHistory = qr.manager.save.mock.calls.some((c: any[]) => c[0] === UserTaskHistoryEntity);
    expect(savedTaskHistory).toBe(false);
    expect(sut.activityLogService.createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        requestParams: expect.objectContaining({ restoreType: 'ALL_SETTLE_AMOUNT', restoreTarget: 'CREDIT' }),
      }),
    );
  });

  it('선입금복구(BALANCE) 는 계정관리 이력관리(UserTaskHistory)에 기록한다', async () => {
    const sut: any = makeSut(false);
    sut.activityLogService = { createLog: jest.fn().mockResolvedValue(undefined) };
    sut.cryptoCipher = {
      safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01000000000'),
      encryptDeliveryTarget: jest.fn((v: string) => v),
    };
    const qr = legacyDiscardQueryRunner();
    const delivery = buildOrderDelivery(IOrderDeliveryStatus.FAIL);
    delivery.orderProductMapping.order.isSettleBalance = true;

    await sut.restoreBalanceOnDiscard(delivery, operator, qr, 'operator');

    const savedTaskHistory = qr.manager.save.mock.calls.filter((c: any[]) => c[0] === UserTaskHistoryEntity);
    expect(savedTaskHistory).toHaveLength(1);
    expect(sut.activityLogService.createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        requestParams: expect.objectContaining({ restoreType: 'BALANCE', restoreTarget: 'DEPOSIT' }),
      }),
    );
  });
});
