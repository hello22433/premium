import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';
import { UserEntity } from '../../entity/user.entity';
import { UserCompanyEntity } from '../../entity/user.company.entity';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';
import { OrderService } from './order.service';

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
    };
    const orderDeliveryRepository = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const userCompanyRepository = {
      save: jest.fn().mockResolvedValue(company),
    };
    const sut: any = Object.create(OrderService.prototype);
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

    await sut.deliveryCancel({ id: 1 } as any, { id: 700, cancelReason: 'cancel' } as any);

    expect(company.balance).toBe(30000);
    expect(oneUser.allSettleAmount).toBe(0);
    expect(sut.orderConfirmationReleaseService.releaseConfirmation).toHaveBeenCalledWith(
      { orderId: 700, reason: 'order_cancel', failedDeliveryIds: null },
      externalManager,
    );
    expect(orderDeliveryRepository.update).toHaveBeenCalledWith(
      { orderProductMappingId: expect.anything() },
      { status: IOrderDeliveryStatus.CANCEL },
    );
  });
});
