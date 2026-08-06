import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';
import { OrderService } from './order.service';
import { BillingScopeLockService } from '../../wallet/application/billing-scope-lock.service';
import { WalletCutoverMode } from '../../wallet/config/wallet-cutover.config';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserStatus } from '../../user/interface/user.status';

describe('OrderService billing lock — lockBillingScope', () => {
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

  const createQueryBuilder = (result: unknown) => ({
    setLock: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(result),
    getOneOrFail: jest.fn().mockResolvedValue(result),
    getMany: jest.fn().mockResolvedValue(result),
  });

  // ── deliveryRequest fixture ─────────────────────────────────────────────

  const createDeliveryRequestService = (companyMode: boolean) => {
    const order = {
      id: 700,
      userId: 10,
      clientUserId: null,
      eventName: 'legacy-lock-test',
      type: IOrderType.GENERAL,
      status: IOrderStatus.TEMP,
      isNewBillingFlow: false,
      orderProductMappings: [
        {
          id: 71,
          amount: 1,
          sendType: 'IMMEDIATE',
          sendTitle: 'title',
          sendContent: 'content',
          product: { price: 10000, useStatus: 'USE' },
          orderDeliveries: [{ id: 91 }],
        },
      ],
    } as any;
    const company = companyMode ? { id: 30, balanceManagementType: 'COMPANY', balance: 50000, maximumLimit: 0 } : null;
    const billingUser = {
      id: 10,
      companyId: company?.id ?? null,
      company,
      balance: 50000,
      allSettleAmount: 0,
    };
    const companyUsers = [billingUser, { id: 11, companyId: company?.id ?? null, allSettleAmount: 0 }];
    const orderQueryBuilder = createQueryBuilder(order);
    const companyUsersQueryBuilder = createQueryBuilder(companyUsers);
    const billingUserQueryBuilder = createQueryBuilder(billingUser);
    const companyQueryBuilder = createQueryBuilder(company);

    const service = Object.create(OrderService.prototype) as any;
    service.orderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(orderQueryBuilder),
      save: jest.fn().mockResolvedValue(undefined),
    };
    service.userRepository = {
      findOne: jest.fn().mockResolvedValue(billingUser),
      find: jest.fn().mockResolvedValue(companyUsers),
      createQueryBuilder: jest
        .fn()
        .mockReturnValueOnce(companyMode ? companyUsersQueryBuilder : billingUserQueryBuilder),
      save: jest.fn().mockResolvedValue(undefined),
    };
    service.userCompanyRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(companyQueryBuilder),
      save: jest.fn().mockResolvedValue(undefined),
    };
    // lockBillingScope 는 BillingScopeLockService 로 위임됨(PR-A). 동일 mock repo 로 실제 서비스를 주입해
    // 잠금 QB 호출(회사→사용자 순서, id ASC)이 그대로 검증되도록 한다.
    service.billingScopeLockService = new BillingScopeLockService(
      service.userRepository,
      service.userCompanyRepository,
    );
    service.orderDeliveryRepository = { save: jest.fn().mockResolvedValue(undefined) };
    service.forbiddenWordMatcher = { scan: jest.fn().mockReturnValue([]) };
    service.logger = { log: jest.fn(), debug: jest.fn() };

    return {
      service,
      order,
      orderQueryBuilder,
      companyUsersQueryBuilder,
      billingUserQueryBuilder,
      companyQueryBuilder,
    };
  };

  // ── deliveryConfirmed fixture ───────────────────────────────────────────
  // deliveryConfirmed 는 lockBillingScope 이후 잔여한도·wallet 등 복잡한 로직이 이어짐.
  // lockBillingScope 호출 자체(잠금 순서·플래그)를 검증하기 위해 spy로 대체하고
  // 이후 로직은 throw 로 조기 종료시킨다.

  const createDeliveryConfirmedService = (companyMode: boolean) => {
    const reviewCompleteOrder = {
      id: 800,
      userId: 10,
      clientUserId: null,
      operationUserId: 20,
      type: IOrderType.GENERAL,
      status: IOrderStatus.REVIEW_COMPLETE,
      isNewBillingFlow: false,
      eventName: 'confirmed-lock-test',
      sendRequestAt: new Date(Date.now() + 60_000),
      orderProductMappings: [
        {
          id: 81,
          amount: 1,
          fee: null,
          priceAdjustment: null,
          sendAmount: 10000,
          sendType: 'IMMEDIATE',
          sendTitle: 'title',
          sendContent: 'content',
          product: {
            price: 10000,
            useStatus: 'USE',
            partnerCompanyId: 1,
            category: null,
            classificationId: null,
            brand: null,
            partnerCompany: { id: 1 },
          },
          orderDeliveries: [{ id: 101, status: 'WAIT', duplicateSendCount: 0 }],
        },
      ],
    } as any;

    const transitionUser = {
      id: 20,
      authority: IUserAuthority.OPERATION_ADMIN,
      status: IUserStatus.USED,
      authorityList: null,
    };

    const company = companyMode ? { id: 30, balanceManagementType: 'COMPANY', balance: 50000, maximumLimit: 0 } : null;
    const billingUser = {
      id: 10,
      companyId: company?.id ?? null,
      company,
      balance: 50000,
      allSettleAmount: 0,
    };
    const companyUsers = [billingUser, { id: 11, companyId: company?.id ?? null, allSettleAmount: 0 }];

    const lockedOrderQB = createQueryBuilder(reviewCompleteOrder);
    const fullOrderQB = createQueryBuilder(reviewCompleteOrder);
    const companyUsersQueryBuilder = createQueryBuilder(companyUsers);
    const billingUserQueryBuilder = createQueryBuilder(billingUser);
    const companyQueryBuilder = createQueryBuilder(company);

    const service = Object.create(OrderService.prototype) as any;
    service.orderRepository = {
      createQueryBuilder: jest.fn().mockReturnValueOnce(lockedOrderQB).mockReturnValueOnce(fullOrderQB),
      manager: {},
    };
    service.userRepository = {
      findOne: jest.fn().mockResolvedValueOnce(transitionUser).mockResolvedValueOnce(billingUser),
      createQueryBuilder: jest
        .fn()
        .mockReturnValueOnce(companyMode ? companyUsersQueryBuilder : billingUserQueryBuilder),
    };
    service.userCompanyRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(companyQueryBuilder),
    };
    service.billingScopeLockService = new BillingScopeLockService(
      service.userRepository,
      service.userCompanyRepository,
    );
    service.logger = { log: jest.fn(), debug: jest.fn() };
    // deliveryConfirmed 진입부에서 wallet 전용 파라미터 게이트가 모드를 참조한다.
    service.walletCutoverConfig = { pr2DeliveryLifecycleMode: WalletCutoverMode.LEGACY };

    // lockBillingScope 내부 QB 호출은 위 mock으로 검증하되,
    // 이후 로직(잔여한도·wallet)은 stub 예외로 조기 종료
    service.userDiscountRepository = {
      find: jest.fn().mockRejectedValue(new Error('__stub_stop__')),
    };

    return {
      service,
      reviewCompleteOrder,
      lockedOrderQB,
      companyUsersQueryBuilder,
      billingUserQueryBuilder,
      companyQueryBuilder,
    };
  };

  // ── deliveryRequest tests ───────────────────────────────────────────────

  describe('deliveryRequest', () => {
    it('TEMP order 조회 시 pessimistic_write 락을 건다', async () => {
      const { service, order, orderQueryBuilder } = createDeliveryRequestService(false);

      await service.deliveryRequest({ id: order.userId } as any, { id: order.id });

      expect(orderQueryBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(orderQueryBuilder.andWhere).toHaveBeenCalledWith('order.status = :status', {
        status: IOrderStatus.TEMP,
      });
    });

    it('PERSONAL 모드: 과금 user row에 pessimistic_write 락을 건다', async () => {
      const { service, order, billingUserQueryBuilder } = createDeliveryRequestService(false);

      await service.deliveryRequest({ id: order.userId } as any, { id: order.id });

      expect(billingUserQueryBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
    });

    it('COMPANY 모드: company row → companyUsers(ID ASC) 순서로 pessimistic_write 락을 건다', async () => {
      const { service, order, companyUsersQueryBuilder, companyQueryBuilder } = createDeliveryRequestService(true);

      await service.deliveryRequest({ id: order.userId } as any, { id: order.id });

      expect(companyQueryBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(companyUsersQueryBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(companyUsersQueryBuilder.orderBy).toHaveBeenCalledWith('companyUser.id', 'ASC');
    });

    it('COMPANY 모드: company 락이 companyUsers 락보다 먼저 호출된다', async () => {
      const { service, order, companyUsersQueryBuilder, companyQueryBuilder } = createDeliveryRequestService(true);
      const callOrder: string[] = [];
      companyQueryBuilder.getOne.mockImplementation(async () => {
        callOrder.push('companyLock');
        return { id: 30, balanceManagementType: 'COMPANY', balance: 50000, maximumLimit: 0 };
      });
      companyUsersQueryBuilder.getMany.mockImplementation(async () => {
        callOrder.push('companyUsersLock');
        const billingUser = { id: 10, companyId: 30, company: null, balance: 50000, allSettleAmount: 0 };
        return [billingUser, { id: 11, companyId: 30, allSettleAmount: 0 }];
      });

      await service.deliveryRequest({ id: order.userId } as any, { id: order.id });

      expect(callOrder.indexOf('companyLock')).toBeLessThan(callOrder.indexOf('companyUsersLock'));
    });
  });

  // ── deliveryConfirmed tests ─────────────────────────────────────────────
  // lockBillingScope 완료 후 userDiscountRepository.find() 에서 __stub_stop__ 예외를 던져
  // 이후 복잡한 로직 실행을 막는다. 락 QB 호출은 그 이전에 이미 완료됨.

  const runConfirmedIgnoringStub = (service: any, orderId: number) =>
    service.deliveryConfirmed({ id: 20 } as any, { id: orderId }).catch((e: Error) => {
      if (e.message !== '__stub_stop__') throw e;
    });

  describe('deliveryConfirmed', () => {
    it('REVIEW_COMPLETE order 조회 시 pessimistic_write 락을 건다', async () => {
      const { service, reviewCompleteOrder, lockedOrderQB } = createDeliveryConfirmedService(false);

      await runConfirmedIgnoringStub(service, reviewCompleteOrder.id);

      expect(lockedOrderQB.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(lockedOrderQB.andWhere).toHaveBeenCalledWith('order.status = :status', {
        status: IOrderStatus.REVIEW_COMPLETE,
      });
    });

    it('PERSONAL 모드: 과금 user row에 pessimistic_write 락을 건다', async () => {
      const { service, reviewCompleteOrder, billingUserQueryBuilder } = createDeliveryConfirmedService(false);

      await runConfirmedIgnoringStub(service, reviewCompleteOrder.id);

      expect(billingUserQueryBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
    });

    it('COMPANY 모드: company row → companyUsers(ID ASC) 순서로 pessimistic_write 락을 건다', async () => {
      const { service, reviewCompleteOrder, companyUsersQueryBuilder, companyQueryBuilder } =
        createDeliveryConfirmedService(true);

      await runConfirmedIgnoringStub(service, reviewCompleteOrder.id);

      expect(companyQueryBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(companyUsersQueryBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(companyUsersQueryBuilder.orderBy).toHaveBeenCalledWith('companyUser.id', 'ASC');
    });

    it('COMPANY 모드: company 락이 companyUsers 락보다 먼저 호출된다', async () => {
      const { service, reviewCompleteOrder, companyUsersQueryBuilder, companyQueryBuilder } =
        createDeliveryConfirmedService(true);
      const callOrder: string[] = [];
      companyQueryBuilder.getOne.mockImplementation(async () => {
        callOrder.push('companyLock');
        return { id: 30, balanceManagementType: 'COMPANY', balance: 50000, maximumLimit: 0 };
      });
      companyUsersQueryBuilder.getMany.mockImplementation(async () => {
        callOrder.push('companyUsersLock');
        const billingUser = { id: 10, companyId: 30, company: null, balance: 50000, allSettleAmount: 0 };
        return [billingUser, { id: 11, companyId: 30, allSettleAmount: 0 }];
      });

      await runConfirmedIgnoringStub(service, reviewCompleteOrder.id);

      expect(callOrder.indexOf('companyLock')).toBeLessThan(callOrder.indexOf('companyUsersLock'));
    });
  });
});
