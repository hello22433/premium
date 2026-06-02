import { ForbiddenException } from '@nestjs/common';
import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';
import { OrderService } from './order.service';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserStatus } from '../../user/interface/user.status';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { IOrderType } from '../interface/order.type';

describe('OrderService delivery transition authority', () => {
  const activeUser = {
    status: IUserStatus.USED,
    authorityList: null,
  };

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

  it('reviewComplete: 고객사 관리자의 직발송 상태 전환을 차단한다', async () => {
    const service = Object.create(OrderService.prototype) as any;
    service.orderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(
        createQueryBuilder({ userId: 10, clientUserId: null, operationUserId: null, type: IOrderType.GENERAL }),
      ),
      save: jest.fn(),
    };
    service.userRepository = {
      findOne: jest.fn().mockResolvedValue({ ...activeUser, id: 10, authority: IUserAuthority.CORPORATE_ADMIN }),
    };

    await expect(
      service.reviewComplete(
        { id: 10, authority: IUserAuthority.CORPORATE_ADMIN },
        { id: 77 },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.orderRepository.save).not.toHaveBeenCalled();
  });

  it('reviewComplete: JWT 권한이 고객사 관리자여도 DB 최신 권한이 운영 관리자이면 직발송 상태 전환을 허용한다', async () => {
    const service = Object.create(OrderService.prototype) as any;
    const order = { userId: 10, clientUserId: null, operationUserId: null, type: IOrderType.GENERAL };
    service.orderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(createQueryBuilder(order)),
      save: jest.fn(),
    };
    service.userRepository = {
      findOne: jest.fn().mockResolvedValue({ ...activeUser, id: 20, authority: IUserAuthority.OPERATION_ADMIN }),
    };

    await service.reviewComplete(
      { id: 20, authority: IUserAuthority.CORPORATE_ADMIN },
      { id: 77 },
    );

    expect(service.userRepository.findOne).toHaveBeenCalledWith({
      where: { id: 20 },
      select: ['id', 'authority', 'status', 'authorityList'],
    });
    expect(service.orderRepository.save).toHaveBeenCalledWith(order);
  });

  it('deliveryConfirmed: 배정되지 않은 운영 담당자의 대행발송 확정을 차단한다', async () => {
    const service = Object.create(OrderService.prototype) as any;
    service.orderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(
        createQueryBuilder({ userId: 20, clientUserId: 30, operationUserId: 20, type: IOrderType.GENERAL }),
      ),
    };
    service.userRepository = {
      findOne: jest.fn().mockResolvedValue({ ...activeUser, id: 21, authority: IUserAuthority.OPERATION_ADMIN }),
      createQueryBuilder: jest.fn(),
    };

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
        createQueryBuilder({ userId: 10, clientUserId: null, operationUserId: null, type: IOrderType.GENERAL }),
      ),
    };
    service.userRepository = {
      findOne: jest.fn().mockResolvedValue({ ...activeUser, id: 10, authority: IUserAuthority.CORPORATE_ADMIN }),
      createQueryBuilder: jest.fn(),
    };

    await expect(
      service.deliveryConfirmed(
        { id: 10, authority: IUserAuthority.CORPORATE_ADMIN },
        { id: 77, forceConfirm: true },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.userRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('deliveryConfirmed: JWT 권한이 운영 관리자여도 DB 최신 권한이 고객사 관리자이면 대행발송 확정을 차단한다', async () => {
    const service = Object.create(OrderService.prototype) as any;
    service.orderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(
        createQueryBuilder({ userId: 20, clientUserId: 30, operationUserId: 20, type: IOrderType.GENERAL }),
      ),
    };
    service.userRepository = {
      findOne: jest.fn().mockResolvedValue({ ...activeUser, id: 20, authority: IUserAuthority.CORPORATE_ADMIN }),
      createQueryBuilder: jest.fn(),
    };

    await expect(
      service.deliveryConfirmed(
        { id: 20, authority: IUserAuthority.OPERATION_ADMIN },
        { id: 77 },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.userRepository.findOne).toHaveBeenCalledWith({
      where: { id: 20 },
      select: ['id', 'authority', 'status', 'authorityList'],
    });
    expect(service.userRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('reviewComplete: DB 최신 계정 상태가 비활성이면 상태 전환을 차단한다', async () => {
    const service = Object.create(OrderService.prototype) as any;
    service.orderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(
        createQueryBuilder({ userId: 10, clientUserId: null, operationUserId: null, type: IOrderType.GENERAL }),
      ),
      save: jest.fn(),
    };
    service.userRepository = {
      findOne: jest.fn().mockResolvedValue({
        ...activeUser,
        id: 20,
        authority: IUserAuthority.OPERATION_ADMIN,
        status: IUserStatus.NOT_USED,
      }),
    };

    await expect(
      service.reviewComplete(
        { id: 20, authority: IUserAuthority.OPERATION_ADMIN },
        { id: 77 },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.orderRepository.save).not.toHaveBeenCalled();
  });

  it('reviewComplete: DB 최신 권한 목록에서 일반 발송 권한이 제거되었으면 상태 전환을 차단한다', async () => {
    const service = Object.create(OrderService.prototype) as any;
    service.orderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(
        createQueryBuilder({ userId: 10, clientUserId: null, operationUserId: null, type: IOrderType.GENERAL }),
      ),
      save: jest.fn(),
    };
    service.userRepository = {
      findOne: jest.fn().mockResolvedValue({
        ...activeUser,
        id: 20,
        authority: IUserAuthority.OPERATION_ADMIN,
        authorityList: UserAuthSubEnum.SEND_SSG,
      }),
    };

    await expect(
      service.reviewComplete(
        { id: 20, authority: IUserAuthority.OPERATION_ADMIN },
        { id: 77 },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.orderRepository.save).not.toHaveBeenCalled();
  });
});
