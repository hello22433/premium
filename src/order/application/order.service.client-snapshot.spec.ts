import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';

jest.mock('./order.snapshot.update.helper', () => {
  const actual = jest.requireActual('./order.snapshot.update.helper');
  return {
    ...actual,
    resolveLineSnapshot: jest.fn(() => ({ snapshotProductPrice: 100 })),
    resolvePartnerSettleSnapshot: jest.fn(() => ({})),
  };
});

import { OrderService } from './order.service';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';
import { IUserAuthority } from '../../user/interface/user.authority';

describe('OrderService updateTemp client snapshot', () => {
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

  const createService = (order: any) => {
    const service = Object.create(OrderService.prototype) as any;
    service.assertPositiveIntegerAmounts = jest.fn();
    service.assertNoForbiddenWord = jest.fn();
    service.validateSendMethods = jest.fn();
    service.orderRepository = {
      findOne: jest.fn().mockResolvedValue(order),
      save: jest.fn().mockResolvedValue(order),
    };
    service.productRepository = { find: jest.fn().mockResolvedValue([{ id: 1, price: 100 }]) };
    service.orderProductMappingRepository = {
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn(),
      save: jest.fn().mockResolvedValue({ id: 101 }),
    };
    service.orderDeliveryRepository = { delete: jest.fn(), insert: jest.fn() };
    service.orderManualEntryRepository = { delete: jest.fn(), insert: jest.fn() };
    service.cryptoCipher = { encryptDeliveryTarget: jest.fn((value) => value) };
    service.userRepository = { findOneOrFail: jest.fn() };
    return service;
  };

  const request = (clientUserId: number | null) => ({
    id: 11,
    eventName: 'event',
    clientUserId,
    orderProductList: [
      {
        productId: 1,
        amount: 1,
        orderDeliveryList: [],
      },
    ],
  });

  const loginUser = { id: 5, authority: IUserAuthority.OPERATION_ADMIN };

  it('고객사 변경 시 전이 스냅샷을 order에 적용하고 저장한다', async () => {
    const order = { id: 11, userId: 5, status: IOrderStatus.TEMP, type: IOrderType.GENERAL, clientUserId: 7 };
    const service = createService(order);
    service.userRepository.findOneOrFail
      .mockResolvedValueOnce({ id: 8, personName: '강한나', personPhoneNumber: '010-1111-2222', email: 'new@test.com', company: null })
      .mockResolvedValueOnce({ id: 5, personName: '운영담당자' });

    await service.updateTemp(loginUser, request(8));

    expect(service.userRepository.findOneOrFail).toHaveBeenCalledTimes(2);
    expect(service.orderRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        clientUserId: 8,
        operationUserId: 5,
        snapshotClientPersonName: '강한나',
        snapshotClientPersonPhone: '010-1111-2222',
        snapshotClientEmail: 'new@test.com',
        snapshotOperationPersonName: '운영담당자',
      }),
    );
  });

  it('고객사 유지 시 사용자 조회와 스냅샷 변경 없이 order를 저장한다', async () => {
    const order = {
      id: 11,
      userId: 5,
      status: IOrderStatus.TEMP,
      type: IOrderType.GENERAL,
      clientUserId: 7,
      snapshotClientPersonName: null,
    };
    const service = createService(order);

    await service.updateTemp(loginUser, request(7));

    expect(service.userRepository.findOneOrFail).not.toHaveBeenCalled();
    expect(service.orderRepository.save).toHaveBeenCalledWith(expect.objectContaining({ snapshotClientPersonName: null }));
  });
});
