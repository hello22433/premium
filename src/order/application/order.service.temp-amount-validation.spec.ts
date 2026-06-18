import { BadRequestException } from '@nestjs/common';
import { OrderService } from './order.service';
import { IOrderType } from '../interface/order.type';
import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';

describe('OrderService temp order amount validation', () => {
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

  const user = {
    id: 1,
    email: 'owner@example.com',
    authority: 'USER',
  };

  const createService = () => {
    const service = Object.create(OrderService.prototype) as any;
    service.assertNoForbiddenWord = jest.fn(() => {
      throw new Error('forbidden word check should not run for invalid amount');
    });
    return service;
  };

  const baseProduct = {
    productId: 1,
    amount: 1,
    orderDeliveryList: [{ deliveryTarget: '01012345678' }],
  };

  it.each([
    ['negative amount', -1],
    ['zero amount', 0],
    ['decimal amount', 1.5],
  ])('rejects %s before createTemp touches downstream checks', async (_caseName, amount) => {
    const service = createService();

    await expect(
      service.createTemp(user, {
        type: IOrderType.GENERAL,
        eventName: 'event',
        orderProductList: [{ ...baseProduct, amount }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.assertNoForbiddenWord).not.toHaveBeenCalled();
  });

  it.each([
    ['negative amount', -1],
    ['zero amount', 0],
    ['decimal amount', 1.5],
  ])('rejects %s before updateTemp touches downstream checks', async (_caseName, amount) => {
    const service = createService();

    await expect(
      service.updateTemp(user, {
        id: 77,
        eventName: 'event',
        orderProductList: [{ ...baseProduct, amount }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.assertNoForbiddenWord).not.toHaveBeenCalled();
  });
});
