import { ForbiddenException } from '@nestjs/common';
import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';
import { OrderService } from './order.service';
import { IUserAuthority } from '../../user/interface/user.authority';

describe('OrderService delivery transition authority', () => {
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
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(result),
  });

  it('reviewComplete: 타인 직발송 주문의 상태 전환을 차단한다', async () => {
    const service = Object.create(OrderService.prototype) as any;
    service.orderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(
        createQueryBuilder({ userId: 10, clientUserId: null, operationUserId: null }),
      ),
      save: jest.fn(),
    };

    await expect(
      service.reviewComplete(
        { id: 11, authority: IUserAuthority.CORPORATE_ADMIN },
        { id: 77 },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.orderRepository.save).not.toHaveBeenCalled();
  });

  it('deliveryConfirmed: 배정되지 않은 운영 담당자의 대행발송 확정을 차단한다', async () => {
    const service = Object.create(OrderService.prototype) as any;
    service.orderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(
        createQueryBuilder({ userId: 20, clientUserId: 30, operationUserId: 20 }),
      ),
    };
    service.userRepository = { createQueryBuilder: jest.fn() };

    await expect(
      service.deliveryConfirmed(
        { id: 21, authority: IUserAuthority.OPERATION_ADMIN },
        { id: 77 },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.userRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('deliveryConfirmed: 일반 고객사의 강제확정을 차단한다', async () => {
    const service = Object.create(OrderService.prototype) as any;
    service.orderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(
        createQueryBuilder({ userId: 10, clientUserId: null, operationUserId: null }),
      ),
    };
    service.userRepository = { createQueryBuilder: jest.fn() };

    await expect(
      service.deliveryConfirmed(
        { id: 10, authority: IUserAuthority.CORPORATE_ADMIN },
        { id: 77, forceConfirm: true },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.userRepository.createQueryBuilder).not.toHaveBeenCalled();
  });
});
