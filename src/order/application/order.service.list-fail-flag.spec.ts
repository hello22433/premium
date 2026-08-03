import { OrderService } from './order.service';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';
import { IOrderSection } from '../interface/order.section';
import { IUserAuthority } from '../../user/interface/user.authority';
import { ViewScopeType } from '../../entity/user.view.scope.entity';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';

/**
 * 발송관리 목록 행 색상 판정의 근거가 되는 hasFailedDelivery 플래그 검증.
 *
 * 재발송이 성공해도 order_delivery.status 는 FAIL/FAIL_SMS 로 남고 resendAt 만 채워진다.
 * 따라서 "아직 남아 있는 실패"는 resendAt IS NULL 인 실패 건으로만 세야 한다.
 * (6건 실패 중 3건만 재발송한 주문이 목록에서 초록(성공)으로 보이던 버그)
 */

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

const makeDelivery = (id: number, status: IOrderDeliveryStatus, resendAt: Date | null) => ({
  id,
  deliveryTarget: '-',
  deletedAt: null,
  status,
  actualSendAt: null,
  resendAt,
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
    clone: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    getRawOne: jest
      .fn()
      .mockResolvedValueOnce({
        total: '2',
        deliveryRequest: '0',
        reviewComplete: '0',
        deliveryConfirmed: '1',
        deliveryComplete: '1',
        deliveryCancel: '0',
      })
      .mockResolvedValueOnce({ failed: '1' }),
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

  return { service };
};

describe('OrderService getList — hasFailedDelivery (미해결 실패 판정)', () => {
  const RESEND_AT = new Date('2026-07-02T10:00:00');

  it('실패 6건 중 3건만 재발송했으면 실패 플래그가 유지된다', async () => {
    const order = makeOrder([
      makeDelivery(1, IOrderDeliveryStatus.FAIL, RESEND_AT),
      makeDelivery(2, IOrderDeliveryStatus.FAIL, RESEND_AT),
      makeDelivery(3, IOrderDeliveryStatus.FAIL_SMS, RESEND_AT),
      makeDelivery(4, IOrderDeliveryStatus.FAIL, null),
      makeDelivery(5, IOrderDeliveryStatus.FAIL, null),
      makeDelivery(6, IOrderDeliveryStatus.FAIL_SMS, null),
    ]);
    const { service } = setupService([order]);

    const result = await service.getList(BASE_USER, BASE_QUERY);

    expect(result.list[0].hasFailedDelivery).toBe(true);
    expect(result.list[0].hasResentDelivery).toBe(true);
  });

  it('실패 건을 모두 재발송했으면 실패 플래그가 내려간다', async () => {
    const order = makeOrder([
      makeDelivery(1, IOrderDeliveryStatus.FAIL, RESEND_AT),
      makeDelivery(2, IOrderDeliveryStatus.FAIL_SMS, RESEND_AT),
      makeDelivery(3, IOrderDeliveryStatus.COMPLETE, null),
    ]);
    const { service } = setupService([order]);

    const result = await service.getList(BASE_USER, BASE_QUERY);

    expect(result.list[0].hasFailedDelivery).toBe(false);
    expect(result.list[0].hasResentDelivery).toBe(true);
  });

  it('재발송 이력이 없는 실패 건은 그대로 실패로 본다', async () => {
    const order = makeOrder([
      makeDelivery(1, IOrderDeliveryStatus.FAIL, null),
      makeDelivery(2, IOrderDeliveryStatus.COMPLETE, null),
    ]);
    const { service } = setupService([order]);

    const result = await service.getList(BASE_USER, BASE_QUERY);

    expect(result.list[0].hasFailedDelivery).toBe(true);
    expect(result.list[0].hasResentDelivery).toBe(false);
  });
});

describe('OrderService getListSummary', () => {
  it('상태별 및 실패 포함 주문 수를 DISTINCT 주문 기준으로 반환한다', async () => {
    const { service } = setupService([]);
    const result = await service.getListSummary(BASE_USER, BASE_QUERY);

    expect(result).toEqual({
      total: 2,
      deliveryRequest: 0,
      reviewComplete: 0,
      deliveryConfirmed: 1,
      deliveryComplete: 1,
      deliveryCancel: 0,
      failed: 1,
    });

    const selectCalls = service.orderRepository.createQueryBuilder.mock.results[0].value.select.mock.calls;
    expect(selectCalls[0][0]).toContain('COUNT(DISTINCT order.id)');
    expect(selectCalls[1][0]).toBe('COUNT(DISTINCT order.id)');
  });

  it('목록 실패 필터는 미해결 실패 delivery EXISTS 조건을 추가한다', async () => {
    const { service } = setupService([]);
    await service.getList(BASE_USER, { ...BASE_QUERY, hasFailedDelivery: true });

    expect(service.orderRepository.createQueryBuilder.mock.results[0].value.andWhere).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        failedDeliveryStatuses: [IOrderDeliveryStatus.FAIL, IOrderDeliveryStatus.FAIL_SMS],
      }),
    );
  });
});
