import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';
import { OrderService } from './order.service';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { WalletCutoverMode } from '../../wallet/config/wallet-cutover.config';
import { AllocationResult } from '../../wallet/application/payment-allocation.service';
import { WalletAllocationInputBuilder } from '../../wallet/application/wallet-allocation-input.builder';
import { CreditExcessApprovalDriftError } from '../../wallet/application/credit-excess-approval.errors';
import { buildCreditExcessSnapshot, CreditExcessSnapshot } from './credit-excess-snapshot';
import { CreditExcessApprovalExecutionContext } from './credit-excess-approval.context';

/**
 * [EP-P23] 신용초과 승인 = 서버 발송확정 실행.
 *
 * 사용자 호출은 신용초과에서 항상 승인 요청 안내로 끝나고(재시도 확정 없음),
 * 승인 실행(approvalContext)만 확정을 수행하며 실행 표식을 같은 트랜잭션에 남긴다.
 */
describe('OrderService deliveryConfirmed 신용초과 승인 실행', () => {
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

  const EXCESS_AMOUNT = 3000;
  const PAYABLE_AMOUNT = 10000;

  const createOrder = (type: IOrderType = IOrderType.GENERAL) => {
    const deliveries = [
      {
        id: 1,
        deliveryTarget: '01011112222',
        settleFee: null,
        settlePriceAdjustment: null,
        ssgEventId: type === IOrderType.SSG ? 55 : null,
        status: IOrderDeliveryStatus.TEMP,
      },
    ];
    return {
      id: 77,
      userId: 1,
      clientUserId: 2,
      operationUserId: 1,
      eventName: 'event',
      type,
      status: IOrderStatus.REVIEW_COMPLETE,
      sendAmount: PAYABLE_AMOUNT,
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
            price: PAYABLE_AMOUNT,
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
    type = IOrderType.GENERAL,
    balance = 50000,
    excessAmount = EXCESS_AMOUNT,
  }: {
    mode: WalletCutoverMode;
    type?: IOrderType;
    balance?: number;
    excessAmount?: number;
  }) => {
    const service = Object.create(OrderService.prototype) as any;
    const order = createOrder(type);
    const billingUser = {
      id: 2,
      balance,
      allSettleAmount: 0,
      duplicatePhoneLimit: 0,
      companyId: null,
    };
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
    service.billingScopeLockService = {
      lock: jest.fn().mockResolvedValue({ user: billingUser, companyUsers: [billingUser] }),
    };
    service.userDiscountRepository = { find: jest.fn().mockResolvedValue([]) };
    service.orderProductMappingRepository = { save: jest.fn() };
    service.orderDeliveryRepository = { save: jest.fn().mockResolvedValue(undefined) };
    service.logger = { debug: jest.fn(), warn: jest.fn(), log: jest.fn() };
    service.cryptoCipher = { safeDecryptDeliveryTarget: (v: string) => v };
    service.ssgEventService = { confirmEventBalance: jest.fn().mockResolvedValue(undefined) };
    service.activityLogService = { createLog: jest.fn().mockResolvedValue(undefined) };
    service.walletCutoverConfig = {
      get pr2DeliveryLifecycleMode() {
        return mode;
      },
    };
    service.walletManagedPredicate = { isWalletManaged: jest.fn().mockResolvedValue(false) };
    service.walletAllocationInputBuilder = new WalletAllocationInputBuilder(
      { evaluate: jest.fn().mockResolvedValue('ALLOW') } as any,
      { find: jest.fn().mockResolvedValue([]) } as any,
    );
    service.walletAccountResolverService = {
      resolveForOrder: jest.fn().mockResolvedValue({
        id: 'wallet-1',
        depositBalance: PAYABLE_AMOUNT - excessAmount,
        creditLimit: 0,
        creditUsedAmount: 0,
        settleCondition: 'PRE_PAYMENT',
      }),
    };
    service.paymentAllocationService = {
      allocate: jest.fn(
        (input: any): AllocationResult => ({
          orderId: input.orderId,
          walletAccountId: input.walletAccountId,
          grossSettlementAmount: PAYABLE_AMOUNT,
          pointUsedAmount: 0,
          cardSurchargeBase: PAYABLE_AMOUNT,
          cardSurchargeAmount: 0,
          payableSettlementAmount: PAYABLE_AMOUNT,
          depositUsedAmount: PAYABLE_AMOUNT - excessAmount,
          creditUsedAmount: 0,
          creditExcessAmount: excessAmount,
          cardSurchargeApplied: false,
          hasDiscount: false,
          lines: [],
          pointUsages: [],
          resourceBreakdown: {
            DEPOSIT: PAYABLE_AMOUNT - excessAmount,
            CREDIT: 0,
            CREDIT_EXCESS: excessAmount,
            POINT: 0,
          } as any,
        }),
      ),
    };
    service.orderConfirmationWalletService = {
      persistAllocation: jest.fn(async (input: any) => ({
        allocationId: 'a-1',
        lineIds: [],
        attemptIds: [],
        walletTransactionIds: [],
        finalAllocation: input.allocation,
      })),
    };
    service.orderConfirmationReleaseService = { releaseConfirmation: jest.fn() };
    service.shadowMismatchClassifierService = { classify: jest.fn().mockReturnValue(null) };
    service.creditExcessApprovalService = {
      lockProcessing: jest.fn().mockResolvedValue({ id: '900', status: 'PROCESSING' }),
      recordExecution: jest.fn().mockResolvedValue(undefined),
    };

    return { service, order, billingUser, managedManager };
  };

  const walletSnapshot = (order: any, mode: WalletCutoverMode, excessAmount = EXCESS_AMOUNT): CreditExcessSnapshot =>
    buildCreditExcessSnapshot({
      order,
      lifecycleMode: mode,
      billingUserId: 2,
      walletAccountId: 'wallet-1',
      settleMethod: 'CASH',
      cardSurchargeApplied: false,
      finalAmount: PAYABLE_AMOUNT,
      remainServiceAmount: 50000,
      excessAmount,
      payableSettlementAmount: PAYABLE_AMOUNT,
      usage: {},
      allocation: {
        pointUsedAmount: 0,
        depositUsedAmount: PAYABLE_AMOUNT - excessAmount,
        creditUsedAmount: 0,
        creditExcessAmount: excessAmount,
        cardSurchargeAmount: 0,
      },
    });

  const legacySnapshot = (order: any, mode: WalletCutoverMode, remainServiceAmount: number): CreditExcessSnapshot =>
    buildCreditExcessSnapshot({
      order,
      lifecycleMode: mode,
      billingUserId: 2,
      walletAccountId: null,
      settleMethod: 'CASH',
      cardSurchargeApplied: false,
      finalAmount: PAYABLE_AMOUNT,
      remainServiceAmount,
      excessAmount: PAYABLE_AMOUNT - remainServiceAmount,
      payableSettlementAmount: PAYABLE_AMOUNT,
      usage: {},
      allocation: null,
    });

  const context = (snapshot: CreditExcessSnapshot): CreditExcessApprovalExecutionContext => ({
    approvalId: '900',
    attemptToken: 'token-abc',
    snapshot,
    requesterUserId: 2,
    approverUserId: 9,
    approverEmail: 'operator@example.com',
    ipAddress: '10.0.0.1',
  });

  it('WALLET: 사용자 호출은 신용초과에서 승인 요청 안내만 반환하고 SSG 확정·차감을 하지 않는다', async () => {
    const { service } = createService({ mode: WalletCutoverMode.WALLET, type: IOrderType.SSG });

    const result = await service.deliveryConfirmed({ id: 1 } as any, { id: 77 } as any);

    expect(result.message).toBe('credit_excess');
    expect(result.excessAmount).toBe(EXCESS_AMOUNT);
    expect(service.ssgEventService.confirmEventBalance).not.toHaveBeenCalled();
    expect(service.orderConfirmationWalletService.persistAllocation).not.toHaveBeenCalled();
    expect(service.creditExcessApprovalService.recordExecution).not.toHaveBeenCalled();
  });

  it('WALLET: 승인 실행 1회로 발송확정 + WAIT 등록 + 동일 트랜잭션 실행 표식', async () => {
    const { service, order, managedManager } = createService({ mode: WalletCutoverMode.WALLET });
    const ctx = context(walletSnapshot(order, WalletCutoverMode.WALLET));

    const result = await service.deliveryConfirmed({ id: 1 } as any, { id: 77 } as any, ctx);

    expect(result.message).toBe('success');
    expect(order.status).toBe(IOrderStatus.DELIVERY_CONFIRMED);
    expect(order.isCreditExcess).toBe(true);
    expect(order.orderProductMappings[0].orderDeliveries[0].status).toBe(IOrderDeliveryStatus.WAIT);

    expect(service.creditExcessApprovalService.lockProcessing).toHaveBeenCalledWith(
      managedManager,
      '900',
      'token-abc',
    );
    const [persistArgs] = service.orderConfirmationWalletService.persistAllocation.mock.calls[0];
    expect(persistArgs.creditExcessApprovalId).toBe('900');
    expect(service.creditExcessApprovalService.recordExecution).toHaveBeenCalledWith(managedManager, {
      approvalId: '900',
      orderId: 77,
      attemptToken: 'token-abc',
      lifecycleMode: WalletCutoverMode.WALLET,
    });
  });

  it('WALLET + SSG: 승인 실행에서만 가차감 확정이 수행된다', async () => {
    const { service, order } = createService({ mode: WalletCutoverMode.WALLET, type: IOrderType.SSG });
    const ctx = context(walletSnapshot(order, WalletCutoverMode.WALLET));

    await service.deliveryConfirmed({ id: 1 } as any, { id: 77 } as any, ctx);

    expect(service.ssgEventService.confirmEventBalance).toHaveBeenCalledWith(77);
    expect(service.creditExcessApprovalService.recordExecution).toHaveBeenCalledTimes(1);
  });

  it('WALLET: 스냅샷 금액이 달라지면 발송하지 않고 변경 항목을 알린다', async () => {
    const { service, order } = createService({ mode: WalletCutoverMode.WALLET });
    // 승인 요청 시점 초과액과 확정 시점 초과액이 다른 상황
    const ctx = context(walletSnapshot(order, WalletCutoverMode.WALLET, EXCESS_AMOUNT + 500));

    await expect(service.deliveryConfirmed({ id: 1 } as any, { id: 77 } as any, ctx)).rejects.toBeInstanceOf(
      CreditExcessApprovalDriftError,
    );

    expect(service.ssgEventService.confirmEventBalance).not.toHaveBeenCalled();
    expect(service.orderConfirmationWalletService.persistAllocation).not.toHaveBeenCalled();
    expect(service.creditExcessApprovalService.recordExecution).not.toHaveBeenCalled();
  });

  it('WALLET: 수신 대상이 바뀌면 변경 항목에 수신 대상이 포함된다', async () => {
    const { service, order } = createService({ mode: WalletCutoverMode.WALLET });
    const snapshot = walletSnapshot(order, WalletCutoverMode.WALLET);
    snapshot.deliveries[0].targetFingerprint = 'changed-fingerprint';

    await expect(service.deliveryConfirmed({ id: 1 } as any, { id: 77 } as any, context(snapshot))).rejects.toThrow(
      /수신 대상/,
    );
    expect(service.creditExcessApprovalService.recordExecution).not.toHaveBeenCalled();
  });

  it('WALLET: 총액·초과액이 같아도 lock 후 재원 배분이 달라지면 확정하지 않고 재요청으로 분류한다', async () => {
    const { service, order } = createService({ mode: WalletCutoverMode.WALLET });
    // persistAllocation 이 lock 후 예치금 부족분을 credit 으로 옮긴 상황을 재현한다.
    // payable(10000)·excess(3000) 는 그대로지만 deposit 7000→6000, credit 0→1000 으로 배분만 바뀐다.
    // consume() 는 총액·excess 만 비교하므로 통과하지만, 최종 allocation 재비교가 배분 drift 를 잡아야 한다.
    service.orderConfirmationWalletService.persistAllocation = jest.fn(async (input: any) => ({
      allocationId: 'a-1',
      lineIds: [],
      attemptIds: [],
      walletTransactionIds: [],
      finalAllocation: {
        ...input.allocation,
        depositUsedAmount: input.allocation.depositUsedAmount - 1000,
        creditUsedAmount: input.allocation.creditUsedAmount + 1000,
        resourceBreakdown: {
          ...input.allocation.resourceBreakdown,
          DEPOSIT: input.allocation.depositUsedAmount - 1000,
          CREDIT: input.allocation.creditUsedAmount + 1000,
        },
      },
    }));

    await expect(
      service.deliveryConfirmed(
        { id: 1 } as any,
        { id: 77 } as any,
        context(walletSnapshot(order, WalletCutoverMode.WALLET)),
      ),
    ).rejects.toBeInstanceOf(CreditExcessApprovalDriftError);

    // 사전 비교는 통과했으므로 persistAllocation 은 실행됐지만, 최종 재비교에서 막혀 실행 표식은 남지 않는다.
    expect(service.orderConfirmationWalletService.persistAllocation).toHaveBeenCalled();
    expect(service.creditExcessApprovalService.recordExecution).not.toHaveBeenCalled();
  });

  it.each([
    [WalletCutoverMode.LEGACY, IOrderType.GENERAL],
    [WalletCutoverMode.SHADOW, IOrderType.GENERAL],
    [WalletCutoverMode.LEGACY, IOrderType.SSG],
  ])('%s (%s): 승인 실행이 발송확정과 실행 표식을 남긴다', async (mode, type) => {
    const { service, order, managedManager } = createService({ mode, type, balance: 0 });
    const ctx = context(legacySnapshot(order, mode, 0));

    const result = await service.deliveryConfirmed({ id: 1 } as any, { id: 77 } as any, ctx);

    expect(result.message).toBe('success');
    expect(order.status).toBe(IOrderStatus.DELIVERY_CONFIRMED);
    expect(order.isCreditExcess).toBe(true);
    expect(service.orderConfirmationWalletService.persistAllocation).not.toHaveBeenCalled();
    expect(service.creditExcessApprovalService.recordExecution).toHaveBeenCalledWith(managedManager, {
      approvalId: '900',
      orderId: 77,
      attemptToken: 'token-abc',
      lifecycleMode: mode,
    });
    if (type === IOrderType.SSG) {
      expect(service.ssgEventService.confirmEventBalance).toHaveBeenCalledWith(77);
    }
  });

  it('LEGACY: 사용자 호출은 신용초과에서 승인 요청 안내만 반환한다', async () => {
    const { service } = createService({ mode: WalletCutoverMode.LEGACY, balance: 0 });

    const result = await service.deliveryConfirmed({ id: 1 } as any, { id: 77 } as any);

    expect(result.message).toBe('credit_excess');
    expect(result.excessAmount).toBe(PAYABLE_AMOUNT);
    expect(service.creditExcessApprovalService.recordExecution).not.toHaveBeenCalled();
  });

  it('선점 토큰이 현재 시도가 아니면 확정을 시작하지 않는다', async () => {
    const { service, order } = createService({ mode: WalletCutoverMode.WALLET });
    service.creditExcessApprovalService.lockProcessing.mockRejectedValueOnce(new Error('approval attempt is not current'));

    await expect(
      service.deliveryConfirmed({ id: 1 } as any, { id: 77 } as any, context(walletSnapshot(order, WalletCutoverMode.WALLET))),
    ).rejects.toThrow('approval attempt is not current');

    expect(service.orderRepository.createQueryBuilder).not.toHaveBeenCalled();
    expect(service.creditExcessApprovalService.recordExecution).not.toHaveBeenCalled();
  });
});
