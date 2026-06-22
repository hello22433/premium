// ★ requireActual 스프레드 필수: import 그래프 내 다른 서비스가 Propagation 등 다른 export 를
//   클래스정의 시점에 쓰므로, 전체 모듈을 덮으면 로드가 깨진다. Transactional/runOnTransactionCommit 만 override.
jest.mock('typeorm-transactional', () => ({
  ...jest.requireActual('typeorm-transactional'),
  Transactional: () => () => undefined,
  runOnTransactionCommit: (cb: () => void) => cb(),
}));

import { OrderService } from './order.service';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';
import { IUserAuthority } from '../../user/interface/user.authority';

describe('OrderService.deliveryCancel — 취소메일 after-commit 배선', () => {
  const buildSut = (orderOver: any, userOver: any) => {
    const order = {
      id: 700,
      userId: 5,
      clientUserId: null,
      type: IOrderType.GENERAL,
      status: IOrderStatus.DELIVERY_REQUEST,
      isNewBillingFlow: false,
      settleAmount: 0,
      isSettleBalance: false,
      isCreditExcess: false,
      orderProductMappings: [{ id: 9001, amount: 1, sendType: 'IMMEDIATE', product: { price: 10000 } }],
      ...orderOver,
    };
    const company = { id: 10, businessNumber: '9999999999', balanceManagementType: 'USER' };
    const oneUser = {
      id: 5,
      allSettleAmount: 0,
      authority: IUserAuthority.CORPORATE_ADMIN,
      personEmail: 'rep@client.com',
      company,
      ...userOver,
    };

    const orderBuilder: any = {
      leftJoinAndSelect: () => orderBuilder,
      where: () => orderBuilder,
      getOne: async () => order,
    };
    const orderRepository: any = {
      createQueryBuilder: () => orderBuilder,
      save: jest.fn(async () => order),
      manager: {},
    };
    const userRepository: any = {
      findOneOrFail: async () => oneUser,
      save: jest.fn(async () => oneUser),
      update: jest.fn(async () => undefined),
    };
    const orderDeliveryRepository: any = { update: jest.fn(async () => undefined) };
    const userCompanyRepository: any = { save: jest.fn(async () => company) };
    const walletManagedPredicate: any = { isWalletManaged: async () => false };
    const ssgEventService: any = { restoreEventBalance: jest.fn(async () => undefined) };
    const orderCancelNotificationService: any = { notifyDirectOrderCancel: jest.fn(async () => undefined) };

    const sut: any = Object.create(OrderService.prototype);
    sut.orderRepository = orderRepository;
    sut.userRepository = userRepository;
    sut.orderDeliveryRepository = orderDeliveryRepository;
    sut.userCompanyRepository = userCompanyRepository;
    sut.walletManagedPredicate = walletManagedPredicate;
    sut.ssgEventService = ssgEventService;
    sut.orderCancelNotificationService = orderCancelNotificationService;
    return { sut, order, oneUser, company, orderCancelNotificationService };
  };

  it('GENERAL + 직접주문 + 비-자사회사 + CORPORATE_ADMIN 이면 통지를 1회 호출한다', async () => {
    const { sut, orderCancelNotificationService } = buildSut({}, {});
    await sut.deliveryCancel({ id: 1 } as any, { id: 700, cancelReason: 'cancel' } as any);
    expect(orderCancelNotificationService.notifyDirectOrderCancel).toHaveBeenCalledTimes(1);
  });

  it('대행주문(clientUserId != null)이면 호출하지 않는다', async () => {
    const { sut, orderCancelNotificationService } = buildSut({ clientUserId: 99 }, {});
    await sut.deliveryCancel({ id: 1 } as any, { id: 700, cancelReason: 'cancel' } as any);
    expect(orderCancelNotificationService.notifyDirectOrderCancel).not.toHaveBeenCalled();
  });
});
