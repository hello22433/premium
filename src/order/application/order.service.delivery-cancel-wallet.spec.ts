import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';
import { UserEntity } from '../../entity/user.entity';
import { UserCompanyEntity } from '../../entity/user.company.entity';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';
import { OrderService } from './order.service';

// 레거시 미러는 DB 증감식 UPDATE 다(197-16 리뷰 P1). 이 스펙의 관심사는 지갑/레거시 분기라
// 체인만 이어 준다 — 증감식 형태 검증은 cancel-multiline-baseline.spec 소관.
const mirrorBuilder = () => {
  const mb: any = {
    update: () => mb,
    set: () => mb,
    where: () => mb,
    setParameters: () => mb,
    execute: async () => ({ affected: 1 }),
  };
  return mb;
};

describe('OrderService.deliveryCancel — wallet-managed mirror', () => {
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

  it('settled discard 상태에서 depositRestoredAmount가 depositUsedAmount를 초과해도 legacy company balance를 차감하지 않는다', async () => {
    const sendRequestAt = new Date(Date.now() + 11 * 60 * 1000);
    const order = {
      id: 700,
      userId: 5,
      clientUserId: null,
      type: IOrderType.GENERAL,
      status: IOrderStatus.DELIVERY_CONFIRMED,
      isNewBillingFlow: true,
      settleAmount: 10000,
      isSettleBalance: false,
      isCreditExcess: false,
      orderProductMappings: [
        {
          id: 9001,
          amount: 1,
          sendType: 'RESERVE',
          sendRequestAt,
          product: { price: 10000 },
        },
      ],
    } as any;
    const company = { id: 10, balance: 30000, balanceManagementType: 'COMPANY' } as UserCompanyEntity;
    const oneUser = { id: 5, allSettleAmount: 0, company } as UserEntity;
    const allocation = {
      orderId: 700,
      depositUsedAmount: 0,
      depositRestoredAmount: 10000,
      creditUsedAmount: 0,
      creditUsedRestoredAmount: 0,
      creditExcessAmount: 0,
      creditExcessRestoredAmount: 0,
    } as OrderPaymentAllocationEntity;

    const externalManager = {
      findOne: jest.fn().mockResolvedValue(allocation),
    };
    const orderRepository = {
      manager: externalManager,
      createQueryBuilder: jest.fn(() => {
        const builder: any = {
          setLock: () => builder,
          leftJoinAndSelect: () => builder,
          where: () => builder,
          getOne: jest.fn().mockResolvedValue(order),
        };
        return builder;
      }),
      save: jest.fn().mockResolvedValue(order),
    };
    const userRepository = {
      findOneOrFail: jest.fn().mockResolvedValue(oneUser),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(mirrorBuilder),
    };
    const orderDeliveryRepository: any = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: () => {
        // select/getRawMany 는 findMappingIdsWithActiveDeliveries(취소된 상품행을 컷오프에서 제외) 용.
        // 이 스펙들은 취소된 행이 없는 상황이라 상품행 전부를 살아 있는 것으로 돌려준다.
        const b: any = {
          innerJoin: () => b,
          select: () => b,
          // 전체취소의 발송건 CANCEL 은 조건부 UPDATE(CAS)다 — 조건 검증은 다른 스펙 소관.
          update: () => b,
          set: () => b,
          execute: async () => ({ affected: 3 }),
          where: () => b,
          andWhere: () => b,
          // CAS 뒤 "취소 안 된 발송건이 남았나" 사후검사 — 이 스펙은 남는 것이 없는 상황이다.
          getCount: async () => 0,
          getRawMany: async () => (order.orderProductMappings ?? []).map((m: any) => ({ mappingId: m.id })),
        };
        return b;
      },
    };
    const userCompanyRepository = {
      save: jest.fn().mockResolvedValue(company),
      createQueryBuilder: jest.fn(mirrorBuilder),
    };
    const sut: any = Object.create(OrderService.prototype);
    // 소유권(조회범위) 검증은 order.service.cancel-ownership.spec 에서 다룬다 — 여기선 통과시킨다.
    sut.assertOrderInViewScope = jest.fn().mockResolvedValue(undefined);
    sut.orderRepository = orderRepository;
    sut.userRepository = userRepository;
    sut.orderDeliveryRepository = orderDeliveryRepository;
    sut.userCompanyRepository = userCompanyRepository;
    sut.ssgEventService = { restoreEventBalance: jest.fn() };
    sut.walletManagedPredicate = { isWalletManaged: jest.fn().mockResolvedValue(true) };
    sut.orderConfirmationReleaseService = {
      releaseConfirmation: jest.fn().mockResolvedValue({
        alreadyReleased: false,
        walletTransactionIds: [],
        rolledBackAttemptIds: [],
      }),
    };
    sut.legacyWalletCreditSyncService = { syncCredit: jest.fn(), syncDeposit: jest.fn() };

    await sut.deliveryCancel({ id: 1 } as any, { id: 700, cancelReason: 'cancel' } as any);

    expect(company.balance).toBe(30000);
    expect(oneUser.allSettleAmount).toBe(0);
    expect(sut.orderConfirmationReleaseService.releaseConfirmation).toHaveBeenCalledWith(
      { orderId: 700, reason: 'order_cancel', failedDeliveryIds: null },
      externalManager,
    );
    // ※ "이미 CANCEL 인 건·soft-delete 된 건을 제외하고 덮는다" 는 이제 조건부 UPDATE(CAS)의
    //   WHERE 로 옮겨갔고, 그 조건 전량은 cancel-multiline-baseline.spec 이 문자열로 고정한다.
    //   여기서 repository.update 로 확인하면 그 경로는 아무도 안 쓰므로 무엇을 해도 통과한다.
    expect(orderDeliveryRepository.update).not.toHaveBeenCalled();
    // wallet-managed 는 releaseConfirmation 이 보상 → legacy sync 미호출(이중반영 금지).
    expect(sut.legacyWalletCreditSyncService.syncDeposit).not.toHaveBeenCalled();
    expect(sut.legacyWalletCreditSyncService.syncCredit).not.toHaveBeenCalled();
  });

  it('레거시 취소 선입금(isSettleBalance) 은 legacy balance 복구 후 syncDeposit(+refundAmount, DISCARD_REFUND) 를 호출한다', async () => {
    const sendRequestAt = new Date(Date.now() + 11 * 60 * 1000);
    const order = {
      id: 800,
      userId: 5,
      clientUserId: null,
      type: IOrderType.GENERAL,
      status: IOrderStatus.DELIVERY_CONFIRMED,
      isNewBillingFlow: false,
      settleAmount: 10000,
      isSettleBalance: true,
      isCreditExcess: false,
      orderProductMappings: [
        {
          id: 9002,
          amount: 1,
          sendType: 'RESERVE',
          sendRequestAt,
          product: { price: 10000 },
        },
      ],
    } as any;
    const company = { id: 10, balance: 30000, balanceManagementType: 'COMPANY' } as UserCompanyEntity;
    const oneUser = { id: 5, allSettleAmount: 0, company } as UserEntity;

    const externalManager = { findOne: jest.fn() };
    const orderRepository = {
      manager: externalManager,
      createQueryBuilder: jest.fn(() => {
        const builder: any = {
          setLock: () => builder,
          leftJoinAndSelect: () => builder,
          where: () => builder,
          getOne: jest.fn().mockResolvedValue(order),
        };
        return builder;
      }),
      save: jest.fn().mockResolvedValue(order),
    };
    const userRepository = {
      findOneOrFail: jest.fn().mockResolvedValue(oneUser),
      save: jest.fn().mockResolvedValue(oneUser),
      createQueryBuilder: jest.fn(mirrorBuilder),
    };
    const orderDeliveryRepository: any = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: () => {
        // select/getRawMany 는 findMappingIdsWithActiveDeliveries(취소된 상품행을 컷오프에서 제외) 용.
        // 이 스펙들은 취소된 행이 없는 상황이라 상품행 전부를 살아 있는 것으로 돌려준다.
        const b: any = {
          innerJoin: () => b,
          select: () => b,
          // 전체취소의 발송건 CANCEL 은 조건부 UPDATE(CAS)다 — 조건 검증은 다른 스펙 소관.
          update: () => b,
          set: () => b,
          execute: async () => ({ affected: 3 }),
          where: () => b,
          andWhere: () => b,
          getCount: async () => 0,
          getRawMany: async () => (order.orderProductMappings ?? []).map((m: any) => ({ mappingId: m.id })),
        };
        return b;
      },
    };
    const userCompanyRepository = {
      save: jest.fn().mockResolvedValue(company),
      createQueryBuilder: jest.fn(mirrorBuilder),
    };
    const sut: any = Object.create(OrderService.prototype);
    // 소유권(조회범위) 검증은 order.service.cancel-ownership.spec 에서 다룬다 — 여기선 통과시킨다.
    sut.assertOrderInViewScope = jest.fn().mockResolvedValue(undefined);
    sut.orderRepository = orderRepository;
    sut.userRepository = userRepository;
    sut.orderDeliveryRepository = orderDeliveryRepository;
    sut.userCompanyRepository = userCompanyRepository;
    sut.ssgEventService = { restoreEventBalance: jest.fn() };
    sut.walletManagedPredicate = { isWalletManaged: jest.fn().mockResolvedValue(false) };
    sut.orderConfirmationReleaseService = { releaseConfirmation: jest.fn() };
    sut.legacyWalletCreditSyncService = { syncCredit: jest.fn(), syncDeposit: jest.fn() };

    await sut.deliveryCancel({ id: 1 } as any, { id: 800, cancelReason: 'cancel' } as any);

    expect(company.balance).toBe(40000);
    expect(sut.legacyWalletCreditSyncService.syncDeposit).toHaveBeenCalledWith(
      externalManager,
      expect.objectContaining({
        billingUserId: 5,
        orderId: 800,
        delta: 10000,
        type: 'DISCARD_REFUND',
        idempotencyKey: 'legacy_discard_refund:800:deposit',
      }),
    );
    expect(sut.legacyWalletCreditSyncService.syncCredit).not.toHaveBeenCalled();
    expect(sut.orderConfirmationReleaseService.releaseConfirmation).not.toHaveBeenCalled();
  });

  it('레거시 취소 여신(!isSettleBalance) 은 allSettleAmount 감소 후 syncCredit(-refundAmount, DISCARD_REFUND) 를 호출한다', async () => {
    const sendRequestAt = new Date(Date.now() + 11 * 60 * 1000);
    const order = {
      id: 801,
      userId: 5,
      clientUserId: null,
      type: IOrderType.GENERAL,
      status: IOrderStatus.DELIVERY_CONFIRMED,
      isNewBillingFlow: false,
      settleAmount: 10000,
      isSettleBalance: false,
      isCreditExcess: false,
      orderProductMappings: [
        {
          id: 9003,
          amount: 1,
          sendType: 'RESERVE',
          sendRequestAt,
          product: { price: 10000 },
        },
      ],
    } as any;
    const oneUser = { id: 5, allSettleAmount: 10000, company: null } as unknown as UserEntity;

    const externalManager = { findOne: jest.fn() };
    const orderRepository = {
      manager: externalManager,
      createQueryBuilder: jest.fn(() => {
        const builder: any = {
          setLock: () => builder,
          leftJoinAndSelect: () => builder,
          where: () => builder,
          getOne: jest.fn().mockResolvedValue(order),
        };
        return builder;
      }),
      save: jest.fn().mockResolvedValue(order),
    };
    const userRepository = {
      findOneOrFail: jest.fn().mockResolvedValue(oneUser),
      save: jest.fn().mockResolvedValue(oneUser),
      createQueryBuilder: jest.fn(mirrorBuilder),
    };
    const orderDeliveryRepository: any = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: () => {
        // select/getRawMany 는 findMappingIdsWithActiveDeliveries(취소된 상품행을 컷오프에서 제외) 용.
        // 이 스펙들은 취소된 행이 없는 상황이라 상품행 전부를 살아 있는 것으로 돌려준다.
        const b: any = {
          innerJoin: () => b,
          select: () => b,
          // 전체취소의 발송건 CANCEL 은 조건부 UPDATE(CAS)다 — 조건 검증은 다른 스펙 소관.
          update: () => b,
          set: () => b,
          execute: async () => ({ affected: 3 }),
          where: () => b,
          andWhere: () => b,
          getCount: async () => 0,
          getRawMany: async () => (order.orderProductMappings ?? []).map((m: any) => ({ mappingId: m.id })),
        };
        return b;
      },
    };
    const userCompanyRepository = { save: jest.fn() };
    const sut: any = Object.create(OrderService.prototype);
    // 소유권(조회범위) 검증은 order.service.cancel-ownership.spec 에서 다룬다 — 여기선 통과시킨다.
    sut.assertOrderInViewScope = jest.fn().mockResolvedValue(undefined);
    sut.orderRepository = orderRepository;
    sut.userRepository = userRepository;
    sut.orderDeliveryRepository = orderDeliveryRepository;
    sut.userCompanyRepository = userCompanyRepository;
    sut.ssgEventService = { restoreEventBalance: jest.fn() };
    sut.walletManagedPredicate = { isWalletManaged: jest.fn().mockResolvedValue(false) };
    sut.orderConfirmationReleaseService = { releaseConfirmation: jest.fn() };
    sut.legacyWalletCreditSyncService = { syncCredit: jest.fn(), syncDeposit: jest.fn() };

    await sut.deliveryCancel({ id: 1 } as any, { id: 801, cancelReason: 'cancel' } as any);

    expect(oneUser.allSettleAmount).toBe(0);
    expect(sut.legacyWalletCreditSyncService.syncCredit).toHaveBeenCalledWith(
      externalManager,
      expect.objectContaining({
        billingUserId: 5,
        orderId: 801,
        delta: -10000,
        type: 'DISCARD_REFUND',
      }),
    );
    expect(sut.legacyWalletCreditSyncService.syncDeposit).not.toHaveBeenCalled();
    expect(sut.orderConfirmationReleaseService.releaseConfirmation).not.toHaveBeenCalled();
  });
});
