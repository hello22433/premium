import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrderEventService } from './order.event.service';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IOrderStatus } from '../../order/interface/order.status';
import { IOrderType } from '../../order/interface/order.type';

describe('OrderEventService.setLike', () => {
  const user = {
    id: 10,
    authority: IUserAuthority.CORPORATE_ADMIN,
  } as ILoginUserInfo;

  const createService = () => {
    const orderRepository = {
      findOne: jest.fn(),
    };
    const orderLikeRepository = {
      findOne: jest.fn(),
      save: jest.fn(),
    };

    const service = new OrderEventService(orderRepository as any, orderLikeRepository as any);

    return { service, orderRepository, orderLikeRepository };
  };

  it('allows a user to like their own non-temp order', async () => {
    const { service, orderRepository, orderLikeRepository } = createService();
    orderRepository.findOne.mockResolvedValue({
      id: 100,
      userId: user.id,
      status: IOrderStatus.DELIVERY_REQUEST,
      type: IOrderType.GENERAL,
    });
    orderLikeRepository.findOne.mockResolvedValue(null);

    await service.setLike(user, { orderId: 100, isLike: true });

    expect(orderRepository.findOne).toHaveBeenCalledWith({ where: { id: 100 } });
    expect(orderLikeRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 100,
        userId: user.id,
        isLike: true,
      }),
    );
  });

  it('rejects liking an order owned by another user', async () => {
    const { service, orderRepository, orderLikeRepository } = createService();
    orderRepository.findOne.mockResolvedValue({
      id: 100,
      userId: 999,
      status: IOrderStatus.DELIVERY_REQUEST,
      type: IOrderType.GENERAL,
    });

    await expect(service.setLike(user, { orderId: 100, isLike: true })).rejects.toThrow(ForbiddenException);
    expect(orderLikeRepository.save).not.toHaveBeenCalled();
  });

  it('rejects liking a missing order', async () => {
    const { service, orderRepository, orderLikeRepository } = createService();
    orderRepository.findOne.mockResolvedValue(null);

    await expect(service.setLike(user, { orderId: 100, isLike: true })).rejects.toThrow(NotFoundException);
    expect(orderLikeRepository.save).not.toHaveBeenCalled();
  });

  it('rejects liking a temp order', async () => {
    const { service, orderRepository, orderLikeRepository } = createService();
    orderRepository.findOne.mockResolvedValue({
      id: 100,
      userId: user.id,
      status: IOrderStatus.TEMP,
      type: IOrderType.GENERAL,
    });

    await expect(service.setLike(user, { orderId: 100, isLike: true })).rejects.toThrow(ForbiddenException);
    expect(orderLikeRepository.save).not.toHaveBeenCalled();
  });

  it('rejects liking an order type that is not exposed by order event lists', async () => {
    const { service, orderRepository, orderLikeRepository } = createService();
    orderRepository.findOne.mockResolvedValue({
      id: 100,
      userId: user.id,
      status: IOrderStatus.DELIVERY_REQUEST,
      type: 'REAL_PRODUCT',
    });

    await expect(service.setLike(user, { orderId: 100, isLike: true })).rejects.toThrow(ForbiddenException);
    expect(orderLikeRepository.save).not.toHaveBeenCalled();
  });
});
