import { In, IsNull, Not } from 'typeorm';
import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';
import { OrderService } from './order.service';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';

/**
 * PR2-005 deliveryCancel wallet-managed branch.
 *
 * 시나리오:
 *  - wallet-managed 주문 (allocation 존재) → OrderConfirmationReleaseService.releaseConfirmation 호출 + legacy mirror reverse + user.balance 미기록.
 *  - legacy 주문 (allocation 부재) → 기존 path (user.balance/allSettleAmount 직접 가감) 유지.
 */
describe('OrderService deliveryCancel wallet PR2-005 branch', () => {
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

  const createOrder = ({
    isCompany,
    isNewBillingFlow = true,
    settleAmount = 10000,
    isSettleBalance = true,
  }: {
    isCompany: boolean;
    isNewBillingFlow?: boolean;
    settleAmount?: number;
    isSettleBalance?: boolean;
  }) => {
    void isCompany;
    return {
      id: 555,
      userId: 1,
      clientUserId: 2,
      type: IOrderType.GENERAL,
      status: IOrderStatus.DELIVERY_CONFIRMED,
      isNewBillingFlow,
      settleAmount,
      isSettleBalance,
      isCreditExcess: false,
      cancelReason: null as string | null,
      canceledAt: null as Date | null,
      orderProductMappings: [
        {
          id: 10,
          amount: 1,
          product: { price: 10000 },
          sendType: 'RESERVE',
          sendRequestAt: new Date(Date.now() + 3600_000), // 1h later (>10min)
        },
      ],
    } as any;
  };

  const createService = ({
    isWalletManaged,
    allocation,
    company,
  }: {
    isWalletManaged: boolean;
    allocation?: any;
    company?: { balance: number };
  }) => {
    const service = Object.create(OrderService.prototype) as any;
    const order = createOrder({ isCompany: !!company });

    const billingUser = {
      id: 2,
      balance: 50000,
      allSettleAmount: 10000,
      companyId: company ? 1 : null,
      company: company
        ? {
            id: 1,
            balance: company.balance,
            balanceManagementType: 'COMPANY' as const,
          }
        : null,
    };

    const managedManager = {
      findOne: jest.fn().mockResolvedValue(allocation ?? null),
    };
    // 소유권(조회범위) 검증은 order.service.cancel-ownership.spec 에서 다룬다 — 여기선 통과시킨다.
    service.assertOrderInViewScope = jest.fn().mockResolvedValue(undefined);

    service.orderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(order),
      }),
      save: jest.fn().mockResolvedValue(order),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      manager: managedManager,
    };
    service.userRepository = {
      findOneOrFail: jest.fn().mockResolvedValue(billingUser),
      save: jest.fn().mockResolvedValue(billingUser),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    service.userCompanyRepository = {
      save: jest.fn().mockResolvedValue(company),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    service.orderDeliveryRepository = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: () => {
        const b: any = { innerJoin: () => b, where: () => b, andWhere: () => b, getCount: async () => 0 };
        return b;
      },
    };
    service.ssgEventService = { restoreEventBalance: jest.fn() };
    service.walletManagedPredicate = {
      isWalletManaged: jest.fn().mockResolvedValue(isWalletManaged),
    };
    service.orderConfirmationReleaseService = {
      releaseConfirmation: jest.fn().mockResolvedValue({
        alreadyReleased: false,
        walletTransactionIds: ['tx-1'],
        rolledBackAttemptIds: ['a-1'],
      }),
    };
    service.legacyWalletCreditSyncService = { syncCredit: jest.fn(), syncDeposit: jest.fn() };

    return { service, order, billingUser, managedManager };
  };

  it('wallet-managed: releaseConfirmation 호출 + legacy mirror reverse + user.balance 미기록', async () => {
    const { service, order, billingUser, managedManager } = createService({
      isWalletManaged: true,
      allocation: {
        depositUsedAmount: 6000,
        depositRestoredAmount: 0,
        creditUsedAmount: 3000,
        creditUsedRestoredAmount: 0,
        creditExcessAmount: 1000,
        creditExcessRestoredAmount: 0,
      },
      company: { balance: 20000 },
    });

    await service.deliveryCancel({ id: 1 } as any, { id: order.id, cancelReason: 'oops' } as any);

    // releaseConfirmation called with order_cancel
    expect(service.orderConfirmationReleaseService.releaseConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: order.id,
        reason: 'order_cancel',
        failedDeliveryIds: null,
      }),
      managedManager,
    );

    // legacy mirror reverse
    expect(billingUser.company!.balance).toBe(20000 + 6000); // deposit refund
    expect(billingUser.allSettleAmount).toBe(10000 - (3000 + 1000)); // credit + excess
    expect(order.settleAmount).toBe(0);
    expect(order.isSettleBalance).toBe(false);
    expect(order.isCreditExcess).toBe(false);

    // user.balance 미기록 — userRepository.update 만 호출, balance 필드 미포함
    expect(service.userRepository.save).not.toHaveBeenCalled();
    expect(service.userRepository.update).toHaveBeenCalledWith(
      { id: billingUser.id },
      { allSettleAmount: billingUser.allSettleAmount },
    );

    // status flip + 배송 취소
    expect(order.status).toBe(IOrderStatus.DELIVERY_CANCEL);
    // 이미 CANCEL 인 건(부분취소 이력)과 soft-delete 된 건은 제외하고 덮는다.
    expect(service.orderDeliveryRepository.update).toHaveBeenCalledWith(
      { orderProductMappingId: In([10]), status: Not(IOrderDeliveryStatus.CANCEL), deletedAt: IsNull() },
      { status: IOrderDeliveryStatus.CANCEL, canceledAt: expect.any(Date), cancelReason: expect.any(String) },
    );
  });

  it('legacy-managed (allocation 부재): 기존 path — user.balance 가감', async () => {
    const { service, order, billingUser } = createService({
      isWalletManaged: false,
    });

    await service.deliveryCancel({ id: 1 } as any, { id: order.id, cancelReason: 'manual' } as any);

    // releaseConfirmation 호출 0건
    expect(service.orderConfirmationReleaseService.releaseConfirmation).not.toHaveBeenCalled();

    // 기존 path: isSettleBalance=true → balance 환원
    expect(billingUser.balance).toBe(50000 + 10000); // refundAmount = settleAmount = 10000
    expect(order.isSettleBalance).toBe(false);
    expect(service.userRepository.save).toHaveBeenCalled();
    // legacy 예치금 복구는 wallet 동기화(syncDeposit) 를 동반 (billingUserId=clientUserId=2).
    expect(service.legacyWalletCreditSyncService.syncDeposit).toHaveBeenCalledWith(
      service.orderRepository.manager,
      expect.objectContaining({
        billingUserId: 2,
        orderId: order.id,
        delta: 10000,
        type: 'DISCARD_REFUND',
        idempotencyKey: `legacy_discard_refund:${order.id}:deposit`,
      }),
    );
    expect(service.legacyWalletCreditSyncService.syncCredit).not.toHaveBeenCalled();
  });

  it('wallet-managed but refundAmount=0 (취소 시점에 환불 없음, e.g. REVIEW_COMPLETE) → wallet path 진입 안 함', async () => {
    const { service, order } = createService({
      isWalletManaged: true,
      allocation: { depositUsedAmount: 0, depositRestoredAmount: 0 },
    });
    order.status = IOrderStatus.REVIEW_COMPLETE; // refundAmount=0
    order.settleAmount = 0;

    await service.deliveryCancel({ id: 1 } as any, { id: order.id, cancelReason: 'pre-confirm' } as any);

    expect(service.orderConfirmationReleaseService.releaseConfirmation).not.toHaveBeenCalled();
    expect(service.walletManagedPredicate.isWalletManaged).not.toHaveBeenCalled();
  });
});
