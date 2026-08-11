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
      setLock: () => orderBuilder,
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
    const orderDeliveryRepository: any = {
      update: jest.fn(async () => undefined),
      createQueryBuilder: () => {
        // select/getRawMany 는 findMappingIdsWithActiveDeliveries(취소된 상품행을 컷오프에서 제외) 용.
        // 이 스펙들은 취소된 행이 없는 상황이라 상품행 전부를 살아 있는 것으로 돌려준다.
        const b: any = {
          innerJoin: () => b,
          select: () => b,
          where: () => b,
          andWhere: () => b,
          getCount: async () => 0,
          getRawMany: async () => (order.orderProductMappings ?? []).map((m: any) => ({ mappingId: m.id })),
        };
        return b;
      },
    };
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
    sut.legacyWalletCreditSyncService = { syncCredit: jest.fn(), syncDeposit: jest.fn() };
    // 소유권(조회범위) 검증은 이 테스트의 관심사가 아니다 — 통과시키고 통지 배선만 본다.
    // (계약 자체는 order.service.cancel-ownership.spec.ts 가 고정한다)
    sut.assertOrderInViewScope = jest.fn().mockResolvedValue(undefined);
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
