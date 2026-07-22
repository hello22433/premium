import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';
import { UserEntity } from '../../entity/user.entity';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';
import { OrderService } from './order.service';

/**
 * 회귀 방지: 주문에 포함된 상품이 이후 삭제(product 조인 결과 null)되어도 주문 취소는 허용되어야 한다.
 * 과거에는 totalPrice 계산에서 '상품 정보가 존재하지 않습니다.' 400을 던져 취소가 막혔다.
 * 이제 환불 단가는 주문 시점 스냅샷(snapshotProductPrice)을 사용한다.
 */
describe('OrderService.deliveryCancel — 삭제된 상품 포함 주문', () => {
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

  const buildSut = (order: any, oneUser: any) => {
    const orderRepository = {
      manager: {},
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
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const orderDeliveryRepository: any = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: () => {
        const b: any = { innerJoin: () => b, where: () => b, andWhere: () => b, getCount: async () => 0 };
        return b;
      },
    };
    const userCompanyRepository = { save: jest.fn() };

    const sut: any = Object.create(OrderService.prototype);
    sut.orderRepository = orderRepository;
    sut.userRepository = userRepository;
    sut.orderDeliveryRepository = orderDeliveryRepository;
    sut.userCompanyRepository = userCompanyRepository;
    sut.ssgEventService = { restoreEventBalance: jest.fn() };
    sut.walletManagedPredicate = { isWalletManaged: jest.fn().mockResolvedValue(false) };
    // isSettleBalance=false 인 레거시 경로는 여신 복구를 legacyWalletCreditSyncService 로 동기화한다.
    sut.legacyWalletCreditSyncService = {
      syncCredit: jest.fn().mockResolvedValue(undefined),
      syncDeposit: jest.fn().mockResolvedValue(undefined),
    };
    return { sut, orderRepository, userRepository };
  };

  it('삭제된 상품(product=null)이어도 취소가 되고, 스냅샷 단가로 환불한다', async () => {
    const order = {
      id: 548,
      userId: 5,
      clientUserId: null,
      type: IOrderType.GENERAL,
      status: IOrderStatus.DELIVERY_REQUEST,
      isNewBillingFlow: false,
      isSettleBalance: false,
      orderProductMappings: [
        {
          id: 9001,
          amount: 2,
          sendType: 'IMMEDIATE',
          sendRequestAt: null,
          product: null, // 상품 삭제됨
          snapshotProductPrice: 5000, // 주문 시점 단가
        },
      ],
    } as any;
    const oneUser = { id: 5, allSettleAmount: 10000, company: null } as unknown as UserEntity;

    const { sut, orderRepository, userRepository } = buildSut(order, oneUser);

    await expect(
      sut.deliveryCancel({ id: 1 } as any, { id: 548, cancelReason: '예전 주문 정리' } as any),
    ).resolves.toBeUndefined();

    expect(order.status).toBe(IOrderStatus.DELIVERY_CANCEL);
    // legacy 흐름 환불: allSettleAmount -= totalPrice(5000 * 2)
    expect(oneUser.allSettleAmount).toBe(0);
    expect(orderRepository.save).toHaveBeenCalled();
    expect(userRepository.save).toHaveBeenCalled();
  });
});
