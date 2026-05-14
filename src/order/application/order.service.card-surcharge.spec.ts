import { OrderService } from './order.service';
import { applyCardSurcharge } from '../domain/order.fee.calculator';
import { IOrderStatus } from '../interface/order.status';
import { addTransactionalDataSource, deleteDataSourceByName, initializeTransactionalContext } from 'typeorm-transactional';

describe('OrderService card surcharge settlement priority', () => {
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

  const createService = ({
    settleMethod,
    orderOverrides = {},
    settleFee = 500,
  }: {
    settleMethod: string | null;
    orderOverrides?: Record<string, unknown>;
    settleFee?: number;
  }) => {
    const order = {
      id: 77,
      userId: 1,
      clientUserId: 2,
      sendAmount: 10000,
      settleAmount: 10000,
      cardSurchargeApplied: undefined,
      isNewBillingFlow: true,
      isSettleBalance: true,
      status: IOrderStatus.REVIEW_COMPLETE,
      ...orderOverrides,
    };

    const existingOrderProduct = {
      id: 10,
      orderId: order.id,
      order,
    };

    const queryBuilder = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([existingOrderProduct]),
    };

    const service = Object.create(OrderService.prototype) as any;
    service.orderProductMappingRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      save: jest.fn(),
    };
    service.orderRepository = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    service.userRepository = {
      findOne: jest.fn().mockResolvedValue({
        company: {
          settleMethod,
        },
      }),
      findOneOrFail: jest.fn(),
      save: jest.fn(),
    };
    service.userCompanyRepository = {
      save: jest.fn(),
    };
    service.processSettleList = jest.fn().mockResolvedValue({
      orderProductList: [],
      settleFee,
    });

    return {
      service,
      order,
      settleFee,
    };
  };

  const createBody = (overrides: Record<string, unknown> = {}) =>
    ({
      list: [{ id: 10 }],
      ...overrides,
    }) as any;

  it('createOrderSettle: body 값이 있으면 settleMethod보다 body 값을 우선한다', async () => {
    const { service, order, settleFee } = createService({ settleMethod: 'CARD' });

    await service.createOrderSettle(createBody({ cardSurchargeApplied: false }));

    expect(service.orderRepository.update).toHaveBeenCalledWith(
      { id: order.id },
      {
        settleAmount: applyCardSurcharge(order.sendAmount + settleFee, false),
        cardSurchargeApplied: false,
      },
    );
  });

  it('createOrderSettle: body 값이 없고 settleMethod가 CARD이면 카드할증을 적용한다', async () => {
    const { service, order, settleFee } = createService({ settleMethod: 'CARD' });

    await service.createOrderSettle(createBody());

    expect(service.userRepository.findOne).toHaveBeenCalledWith({
      where: { id: order.clientUserId },
      relations: ['company'],
    });
    expect(service.orderRepository.update).toHaveBeenCalledWith(
      { id: order.id },
      {
        settleAmount: applyCardSurcharge(order.sendAmount + settleFee, true),
        cardSurchargeApplied: true,
      },
    );
  });

  it('createOrderSettle: body 값이 없고 settleMethod가 CARD가 아니면 카드할증을 적용하지 않는다', async () => {
    const { service, order, settleFee } = createService({ settleMethod: 'CASH' });

    await service.createOrderSettle(createBody());

    expect(service.orderRepository.update).toHaveBeenCalledWith(
      { id: order.id },
      {
        settleAmount: applyCardSurcharge(order.sendAmount + settleFee, false),
        cardSurchargeApplied: false,
      },
    );
  });

  it('updateOrderSettle: body 값이 있으면 기존 저장값과 settleMethod보다 body 값을 우선한다', async () => {
    const { service, order, settleFee } = createService({
      settleMethod: 'CASH',
      orderOverrides: {
        cardSurchargeApplied: false,
      },
    });

    await service.updateOrderSettle(createBody({ cardSurchargeApplied: true }));

    expect(service.orderRepository.update).toHaveBeenCalledWith(
      { id: order.id },
      {
        settleAmount: applyCardSurcharge(order.sendAmount + settleFee, true),
        cardSurchargeApplied: true,
      },
    );
  });

  it('updateOrderSettle: body 값이 없으면 기존 저장값을 settleMethod보다 우선한다', async () => {
    const { service, order, settleFee } = createService({
      settleMethod: 'CARD',
      orderOverrides: {
        cardSurchargeApplied: false,
      },
    });

    await service.updateOrderSettle(createBody());

    expect(service.orderRepository.update).toHaveBeenCalledWith(
      { id: order.id },
      {
        settleAmount: applyCardSurcharge(order.sendAmount + settleFee, false),
        cardSurchargeApplied: false,
      },
    );
  });

  it('updateOrderSettle: body 값과 기존 저장값이 모두 없으면 settleMethod 기본값을 사용한다', async () => {
    const { service, order, settleFee } = createService({
      settleMethod: 'CARD',
      orderOverrides: {
        cardSurchargeApplied: undefined,
      },
    });

    await service.updateOrderSettle(createBody());

    expect(service.orderRepository.update).toHaveBeenCalledWith(
      { id: order.id },
      {
        settleAmount: applyCardSurcharge(order.sendAmount + settleFee, true),
        cardSurchargeApplied: true,
      },
    );
  });
});
