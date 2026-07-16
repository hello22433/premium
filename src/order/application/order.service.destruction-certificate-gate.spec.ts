import { OrderService } from './order.service';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';
import { IOrderSection } from '../interface/order.section';
import { IUserAuthority } from '../../user/interface/user.authority';
import { ViewScopeType } from '../../entity/user.view.scope.entity';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { DestructionCertificateBlockReason } from '../interface/destruction.certificate.block.reason';

const BASE_USER = {
  id: 1,
  email: 'admin@test.com',
  authority: IUserAuthority.SUPER_ADMIN,
} as any;

const BASE_QUERY = {
  type: IOrderType.GENERAL,
  section: IOrderSection.ORDER,
  page: 1,
  take: 20,
  searchType: 'ALL',
  searchKeyword: '',
  sendingType: null,
  dateType: null,
  startAt: undefined,
  endAt: undefined,
  status: undefined,
} as any;

const makeDelivery = (id: number, deliveryTarget: string, deletedAt: Date | null = null) => ({
  id,
  deliveryTarget,
  deletedAt,
  status: IOrderDeliveryStatus.COMPLETE,
  actualSendAt: null,
  resendAt: null,
  refundStatus: null,
});

const makeOrder = (orderDeliveries: ReturnType<typeof makeDelivery>[]) => ({
  id: 1,
  registerAt: new Date('2026-07-01T00:00:00'),
  status: IOrderStatus.DELIVERY_COMPLETE,
  eventName: '테스트',
  sendAmount: 10000,
  settleAmount: 10000,
  clientUserId: null,
  clientUser: null,
  operationUser: null,
  operationUserId: null,
  snapshotPersonName: '홍길동',
  snapshotBusinessName: '테스트고객사',
  snapshotPersonPhone: null,
  snapshotEmail: null,
  snapshotBusinessNumber: '',
  snapshotBusinessAddress: null,
  snapshotIndustryType: null,
  snapshotIndustryItem: null,
  snapshotSettleCondition: 'MONTHLY',
  snapshotDocumentCompanyType: 'ENMAD',
  user: null,
  orderProductMappings: [
    {
      id: 1,
      amount: 1,
      sendType: 'IMMEDIATE',
      sendRequestAt: null,
      requestToDestroyPersonalInfoDay: 0,
      product: { name: '상품A' },
      orderDeliveries,
    },
  ],
});

const setupService = (orders: any[]) => {
  const qb: any = {
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    withDeleted: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([orders, orders.length]),
  };

  const service = Object.create(OrderService.prototype) as any;
  service.orderRepository = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
  service.userRepository = {
    findOne: jest.fn().mockResolvedValue({ id: BASE_USER.id, companyId: null, departmentId: null }),
  };
  service.userViewScopeRepository = {
    findOne: jest.fn().mockResolvedValue({ scopeType: ViewScopeType.ALL, getDeptIdList: () => [] }),
  };
  service['applyDirectSendingFilter'] = jest.fn();
  service['applyOrderSearchCondition'] = jest.fn().mockReturnValue(qb);
  service['applyOrderDateCondition'] = jest.fn().mockReturnValue(qb);
  service['applyViewScopeFilter'] = jest.fn().mockReturnValue(qb);

  return { service, qb };
};

describe('OrderService getList — destruction certificate gate', () => {
  it('soft-delete 된 미파기 롤백 행이 있으면 목록 게이트는 NOT_DESTROYED 를 내려준다', async () => {
    const order = makeOrder([
      makeDelivery(1, '-'),
      makeDelivery(2, 'enc-01012341234', new Date('2026-07-01T00:00:00')),
    ]);
    const { service, qb } = setupService([order]);

    const result = await service.getList(BASE_USER, BASE_QUERY);

    expect(result.list[0].canIssueDestructionCertificate).toBe(false);
    expect(result.list[0].destructionCertificateBlockReason).toBe(DestructionCertificateBlockReason.NOT_DESTROYED);
    expect(qb.withDeleted).toHaveBeenCalled();

    const deliveryJoinCallOrder = qb.leftJoinAndSelect.mock.calls.findIndex(
      ([relation]: [string]) => relation === 'orderProductMappings.orderDeliveries',
    );
    expect(deliveryJoinCallOrder).toBeGreaterThanOrEqual(0);
    expect(qb.withDeleted.mock.invocationCallOrder[0]).toBeLessThan(
      qb.leftJoinAndSelect.mock.invocationCallOrder[deliveryJoinCallOrder],
    );
  });
});
