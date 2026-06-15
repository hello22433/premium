import { CustomerServiceService } from './customer.service.service';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { OrderDeliveryAttemptType } from '../../entity/order.delivery.attempt.entity';

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
    sut.cryptoCipher = { safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01012345678') };
    sut.walletManagedPredicate = { isWalletManaged: jest.fn().mockResolvedValue(true) };
    sut.refundPoolService = {
      refundSettledDiscardToDeposit: jest.fn().mockResolvedValue({ ledgerIds: ['1'], totalRefundedAmount: 10000 }),
    };

    const orderDelivery = buildOrderDelivery(IOrderDeliveryStatus.COMPLETE);
    orderDelivery.orderProductMapping.order.isSettleComplete = true;

    await sut.restoreBalanceOnDiscard(
      orderDelivery,
      operator,
      queryRunner,
      'operator',
    );

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
    sut.cryptoCipher = { safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01012345678') };
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
});
