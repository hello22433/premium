import { BadRequestException } from '@nestjs/common';
import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';
import { OrderService } from './order.service';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { WalletCutoverMode } from '../../wallet/config/wallet-cutover.config';
import { AllocationResult } from '../../wallet/application/payment-allocation.service';

/**
 * PR2-005 Wallet hook on deliveryConfirmed.
 *
 * 3-mode gate 분기 검증 (unit-style — wallet services mocked).
 * 실제 DB hit 통합은 PR2-007 e2e (out of scope here).
 */
describe('OrderService deliveryConfirmed wallet PR2-005 gating', () => {
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

  const createOrder = () => {
    const deliveries = [{ id: 1, deliveryTarget: '01011112222', settleFee: null, settlePriceAdjustment: null }];
    return {
      id: 77,
      userId: 1,
      clientUserId: 2,
      operationUserId: 1,
      eventName: 'event',
      type: IOrderType.GENERAL,
      status: IOrderStatus.REVIEW_COMPLETE,
      sendAmount: 10000,
      cardSurchargeApplied: false,
      isNewBillingFlow: true,
      orderProductMappings: [
        {
          id: 10,
          productId: 100,
          amount: 1,
          fee: null,
          priceAdjustment: null,
          sendTitle: 'title',
          sendContent: 'content',
          product: {
            price: 10000,
            useStatus: 'USE',
            partnerCompanyId: 20,
            partnerCompany: {},
            brandId: 30,
            brand: { id: 30 },
            category: 'GIFT',
          },
          orderDeliveries: deliveries,
        },
      ],
    } as any;
  };

  const createQueryBuilder = (result: unknown) => ({
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(result),
    getOneOrFail: jest.fn().mockResolvedValue(result),
  });

  const createService = ({
    mode,
    persistAllocationImpl,
  }: {
    mode: WalletCutoverMode;
    persistAllocationImpl?: () => Promise<unknown>;
  }) => {
    const service = Object.create(OrderService.prototype) as any;
    const order = createOrder();
    const billingUser = {
      id: 2,
      balance: 50000,
      allSettleAmount: 0,
      duplicatePhoneLimit: 0,
      companyId: null,
    };

    // managed manager stub (typeorm-transactional cls 가 fake 라서 raw object)
    const managedManager = { __stub: true };

    service.orderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(createQueryBuilder(order)),
      save: jest.fn().mockResolvedValue(order),
      manager: managedManager,
    };
    service.userRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 1,
        authority: 'OPERATION_ADMIN',
        status: 'USED',
        authorityList: null,
      }),
      createQueryBuilder: jest.fn().mockReturnValue(createQueryBuilder(billingUser)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    service.userCompanyRepository = { update: jest.fn() };
    service.userDiscountRepository = { find: jest.fn().mockResolvedValue([]) };
    service.orderProductMappingRepository = { save: jest.fn() };
    service.orderDeliveryRepository = { save: jest.fn().mockResolvedValue(undefined) };
    service.logger = { debug: jest.fn(), warn: jest.fn(), log: jest.fn() };
    service.cryptoCipher = { safeDecryptDeliveryTarget: (v: string) => v };
    service.ssgEventService = { confirmEventBalance: jest.fn() };

    service.walletCutoverConfig = {
      get pr2DeliveryLifecycleMode() {
        return mode;
      },
    };
    service.walletManagedPredicate = { isWalletManaged: jest.fn().mockResolvedValue(false) };
    service.walletAccountResolverService = {
      resolveForOrder: jest.fn().mockResolvedValue({
        id: 'wallet-1',
        depositBalance: 100000,
        creditLimit: 0,
        creditUsedAmount: 0,
        settleCondition: 'PRE_PAYMENT',
      }),
    };
    service.paymentAllocationService = {
      allocate: jest.fn((input: any): AllocationResult => ({
        orderId: input.orderId,
        walletAccountId: input.walletAccountId,
        grossSettlementAmount: 10000,
        pointUsedAmount: 0,
        cardSurchargeBase: 10000,
        cardSurchargeAmount: 0,
        payableSettlementAmount: 10000,
        depositUsedAmount: 10000,
        creditUsedAmount: 0,
        creditExcessAmount: 0,
        cardSurchargeApplied: false,
        hasDiscount: false,
        lines: [],
        pointUsages: [],
        resourceBreakdown: { DEPOSIT: 10000, CREDIT: 0, CREDIT_EXCESS: 0, POINT: 0 } as any,
      })),
    };
    service.orderConfirmationWalletService = {
      persistAllocation: jest.fn(
        persistAllocationImpl ?? (async () => ({
          allocationId: 'a-1',
          lineIds: [],
          attemptIds: [],
          walletTransactionIds: [],
        })),
      ),
    };
    service.orderConfirmationReleaseService = { releaseConfirmation: jest.fn() };
    service.shadowMismatchClassifierService = {
      classify: jest.fn().mockReturnValue(null),
    };

    return { service, order, billingUser, managedManager };
  };

  it('LEGACY mode: wallet 서비스 호출 0 + user.balance 갱신', async () => {
    const { service, billingUser } = createService({ mode: WalletCutoverMode.LEGACY });

    await service.deliveryConfirmed({ id: 1 } as any, { id: 77 } as any);

    expect(service.paymentAllocationService.allocate).not.toHaveBeenCalled();
    expect(service.orderConfirmationWalletService.persistAllocation).not.toHaveBeenCalled();
    expect(service.userRepository.update).toHaveBeenCalledWith(
      { id: billingUser.id },
      expect.objectContaining({ balance: expect.any(Number) }),
    );
  });

  it('WALLET mode: persistAllocation 호출 + user.balance 미포함 + allocation totals 반영', async () => {
    const { service, order, billingUser, managedManager } = createService({ mode: WalletCutoverMode.WALLET });

    await service.deliveryConfirmed({ id: 1 } as any, { id: 77 } as any);

    expect(service.orderConfirmationWalletService.persistAllocation).toHaveBeenCalledTimes(1);
    const [persistArgs, manager] = service.orderConfirmationWalletService.persistAllocation.mock.calls[0];
    expect(manager).toBe(managedManager);
    expect(persistArgs.orderId).toBe(order.id);
    expect(persistArgs.creditExcessApprovalId).toBeNull();
    expect(persistArgs.deliveryIdsForAttempt).toEqual([1]);

    // user.balance 미기록 (wallet ledger 가 진실의 원천)
    const updateCall = service.userRepository.update.mock.calls[0];
    expect(updateCall[0]).toEqual({ id: billingUser.id });
    expect(updateCall[1]).not.toHaveProperty('balance');
    expect(updateCall[1]).toHaveProperty('allSettleAmount');

    expect(order.settleAmount).toBe(10000);
    expect(order.isSettleBalance).toBe(true);
    expect(order.isCreditExcess).toBe(false);
  });

  it('WALLET mode: persistAllocation throw → 호출자에 전파 (TX rollback 트리거)', async () => {
    const { service } = createService({
      mode: WalletCutoverMode.WALLET,
      persistAllocationImpl: () => Promise.reject(new BadRequestException('test_throw')),
    });

    await expect(service.deliveryConfirmed({ id: 1 } as any, { id: 77 } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    // legacy mirror 도 throw 이후 도달하지 않음 (user.update 미호출)
    expect(service.userRepository.update).not.toHaveBeenCalled();
  });

  it('WALLET mode: 이미 wallet-managed → BadRequestException', async () => {
    const { service } = createService({ mode: WalletCutoverMode.WALLET });
    service.walletManagedPredicate.isWalletManaged.mockResolvedValueOnce(true);

    await expect(service.deliveryConfirmed({ id: 1 } as any, { id: 77 } as any)).rejects.toThrow(
      'order already wallet-confirmed',
    );
    expect(service.orderConfirmationWalletService.persistAllocation).not.toHaveBeenCalled();
  });
});

/**
 * Keep IPriceAdjustment import live (lint) — used in fixture authoring for future tests.
 */
void IPriceAdjustment;
