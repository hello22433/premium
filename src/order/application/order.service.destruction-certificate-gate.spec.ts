import { format } from 'date-fns';
import { OrderService } from './order.service';
import { DateFormatStr } from '../../common/domain/date.format.str';
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

const makeDelivery = (
  id: number,
  deliveryTarget: string,
  deletedAt: Date | null = null,
  overrides: Partial<{
    status: IOrderDeliveryStatus;
    actualSendAt: Date | null;
    resendAt: Date | null;
    refundStatus: any;
  }> = {},
) => ({
  id,
  deliveryTarget,
  deletedAt,
  status: overrides.status ?? IOrderDeliveryStatus.COMPLETE,
  actualSendAt: overrides.actualSendAt ?? null,
  resendAt: overrides.resendAt ?? null,
  refundStatus: overrides.refundStatus ?? null,
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

const makeReserveOrder = (
  products: { productName: string; sendRequestAt: Date; deliveries: ReturnType<typeof makeDelivery>[] }[],
) => ({
  ...makeOrder([]),
  orderProductMappings: products.map((p, index) => ({
    id: index + 1,
    amount: 1,
    sendType: 'RESERVE',
    sendRequestAt: p.sendRequestAt,
    requestToDestroyPersonalInfoDay: 0,
    product: { name: p.productName },
    orderDeliveries: p.deliveries,
  })),
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

  it('soft-delete 된 배송건은 목록 표시 계산(발송시간·실패·재발송)에서 제외한다', async () => {
    // 활성 배송 1건(정상 완료) + soft-delete 배송 1건(실패·재발송).
    // soft-delete 행은 파기확인서 게이트 판정에만 쓰이고 목록 표시에는 섞이면 안 된다.
    const activeSendAt = new Date('2026-07-02T10:00:00');
    const order = makeOrder([
      makeDelivery(1, '-', null, { status: IOrderDeliveryStatus.COMPLETE, actualSendAt: activeSendAt }),
      makeDelivery(2, 'enc-01012341234', new Date('2026-07-01T00:00:00'), {
        status: IOrderDeliveryStatus.FAIL,
        actualSendAt: new Date('2026-07-01T09:00:00'),
        resendAt: new Date('2026-07-01T11:00:00'),
      }),
    ]);
    const { service } = setupService([order]);

    const result = await service.getList(BASE_USER, BASE_QUERY);

    // 실패/재발송은 soft-delete 배송건에만 있으므로 목록에는 반영되지 않아야 한다.
    expect(result.list[0].hasFailedDelivery).toBe(false);
    expect(result.list[0].hasResentDelivery).toBe(false);
    // 발송시간은 활성 배송건 기준이어야 한다.
    expect(result.list[0].actualSendAt).toBe(format(activeSendAt, DateFormatStr));
  });

  it('완료 상태의 soft-delete 배송건이 앞서 있어도 발송시간은 활성 배송건 기준으로 뽑는다', async () => {
    // soft-delete 배송이 COMPLETE + 더 이른 actualSendAt 로 배열 앞에 있으면,
    // 활성 필터가 없을 때 이 값이 잘못 선택된다. 필터가 있어야 활성 배송 시간이 나온다.
    const deletedSendAt = new Date('2026-07-01T08:00:00');
    const activeSendAt = new Date('2026-07-02T10:00:00');
    const order = makeOrder([
      makeDelivery(1, 'enc-01012341234', new Date('2026-07-01T00:00:00'), {
        status: IOrderDeliveryStatus.COMPLETE,
        actualSendAt: deletedSendAt,
      }),
      makeDelivery(2, '-', null, { status: IOrderDeliveryStatus.COMPLETE, actualSendAt: activeSendAt }),
    ]);
    const { service } = setupService([order]);

    const result = await service.getList(BASE_USER, BASE_QUERY);

    expect(result.list[0].actualSendAt).toBe(format(activeSendAt, DateFormatStr));
  });

  it('상품별 예약 발송시간(productSendTimes)도 soft-delete 배송건을 제외한다', async () => {
    // RESERVE 상품 2건(분 단위 distinct ≥ 2)이라 productSendTimes 가 채워진다.
    // 각 상품의 발송시간은 활성 배송건 기준이어야 하고, soft-delete 배송건은 섞이면 안 된다.
    const order = makeReserveOrder([
      {
        productName: '상품A',
        sendRequestAt: new Date('2026-07-02T10:00:00'),
        deliveries: [
          // soft-delete 배송의 발송시간을 활성보다 더 늦게 둔다.
          // productSendTimes 는 max(actualSendAt) 를 뽑으므로, 필터가 없으면 이 값이 선택된다.
          makeDelivery(1, 'enc-a-deleted', new Date('2026-07-01T00:00:00'), {
            status: IOrderDeliveryStatus.COMPLETE,
            actualSendAt: new Date('2026-07-03T09:00:00'),
          }),
          makeDelivery(2, '-', null, {
            status: IOrderDeliveryStatus.COMPLETE,
            actualSendAt: new Date('2026-07-02T10:05:00'),
          }),
        ],
      },
      {
        productName: '상품B',
        sendRequestAt: new Date('2026-07-02T11:00:00'),
        deliveries: [
          makeDelivery(3, '-', null, {
            status: IOrderDeliveryStatus.COMPLETE,
            actualSendAt: new Date('2026-07-02T11:05:00'),
          }),
        ],
      },
    ]);
    const { service } = setupService([order]);

    const result = await service.getList(BASE_USER, BASE_QUERY);

    const productSendTimes = result.list[0].productSendTimes!;
    expect(productSendTimes).toBeDefined();
    const productA = productSendTimes.find((p: { productName: string }) => p.productName === '상품A')!;
    // soft-delete 배송(07-01 08:00)이 아니라 활성 배송(07-02 10:05)이 나와야 한다.
    expect(productA.actualSendAt).toBe(format(new Date('2026-07-02T10:05:00'), DateFormatStr));
  });
});
