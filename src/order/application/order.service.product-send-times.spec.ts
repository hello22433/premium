import { OrderService } from './order.service';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';
import { IOrderSection } from '../interface/order.section';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { ViewScopeType } from '../../entity/user.view.scope.entity';

/**
 * getList() — productSendTimes 필드 검증
 * RESERVE 상품 분 단위 distinct ≥ 2일 때만 배열 채움.
 * per-mapping actualSendAt은 가장 최근 COMPLETE 건 기준.
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

const makeDelivery = (id: number, status: IOrderDeliveryStatus, actualSendAt: Date | null) => ({
  id,
  status,
  actualSendAt,
  resendAt: null,
});

const makeMapping = (
  id: number,
  productName: string,
  sendType: string,
  sendRequestAt: Date | null,
  deliveries: ReturnType<typeof makeDelivery>[],
) => ({
  id,
  amount: 1,
  sendType,
  sendRequestAt,
  requestToDestroyPersonalInfoDay: 0,
  product: { name: productName },
  orderDeliveries: deliveries,
});

const makeOrder = (mappings: ReturnType<typeof makeMapping>[]) => ({
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
  orderProductMappings: mappings,
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

  return service;
};

describe('OrderService getList — productSendTimes', () => {
  describe('트리거 조건: RESERVE 분 단위 distinct', () => {
    it('RESERVE 상품이 없으면 productSendTimes 미포함', async () => {
      const mappings = [makeMapping(1, '상품A', 'IMMEDIATE', null, []), makeMapping(2, '상품B', 'IMMEDIATE', null, [])];
      const service = setupService([makeOrder(mappings)]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      expect(result.list[0].productSendTimes).toBeUndefined();
    });

    it('RESERVE 상품이 1개면 distinct=1이므로 productSendTimes 미포함', async () => {
      const mappings = [makeMapping(1, '상품A', 'RESERVE', new Date('2026-07-01T09:00:00'), [])];
      const service = setupService([makeOrder(mappings)]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      expect(result.list[0].productSendTimes).toBeUndefined();
    });

    it('RESERVE 상품 2개가 같은 분 슬롯이면 distinct=1이므로 미포함', async () => {
      const mappings = [
        makeMapping(1, '상품A', 'RESERVE', new Date('2026-07-01T09:00:00'), []),
        makeMapping(2, '상품B', 'RESERVE', new Date('2026-07-01T09:00:30'), []),
      ];
      const service = setupService([makeOrder(mappings)]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      expect(result.list[0].productSendTimes).toBeUndefined();
    });

    it('RESERVE 상품 2개가 다른 분 슬롯이면 distinct=2이므로 배열 채움', async () => {
      const mappings = [
        makeMapping(1, '상품A', 'RESERVE', new Date('2026-07-01T09:00:00'), []),
        makeMapping(2, '상품B', 'RESERVE', new Date('2026-07-01T14:00:00'), []),
      ];
      const service = setupService([makeOrder(mappings)]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      expect(result.list[0].productSendTimes).toHaveLength(2);
    });

    it('IMMEDIATE+RESERVE 혼재 시 IMMEDIATE는 산정 제외, RESERVE distinct만 계산', async () => {
      const mappings = [
        makeMapping(1, '즉시상품', 'IMMEDIATE', null, []),
        makeMapping(2, '예약A', 'RESERVE', new Date('2026-07-01T09:00:00'), []),
        makeMapping(3, '예약B', 'RESERVE', new Date('2026-07-01T09:00:00'), []),
      ];
      const service = setupService([makeOrder(mappings)]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      // RESERVE distinct=1 → 미포함
      expect(result.list[0].productSendTimes).toBeUndefined();
    });

    it('IMMEDIATE+RESERVE 혼재 시 RESERVE distinct≥2이면 배열은 RESERVE 항목만 담음', async () => {
      const mappings = [
        makeMapping(1, '즉시상품', 'IMMEDIATE', null, []),
        makeMapping(2, '예약A', 'RESERVE', new Date('2026-07-01T09:00:00'), []),
        makeMapping(3, '예약B', 'RESERVE', new Date('2026-07-01T14:00:00'), []),
      ];
      const service = setupService([makeOrder(mappings)]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      const times = result.list[0].productSendTimes!;
      expect(times).toHaveLength(2);
      expect(times.map((t: any) => t.productName)).not.toContain('즉시상품');
    });
  });

  describe('배열 항목 내용', () => {
    it('productName이 product.name으로 채워짐', async () => {
      const mappings = [
        makeMapping(1, '스타벅스 아메리카노', 'RESERVE', new Date('2026-07-01T09:00:00'), []),
        makeMapping(2, '스타벅스 라떼', 'RESERVE', new Date('2026-07-01T14:00:00'), []),
      ];
      const service = setupService([makeOrder(mappings)]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      const names = result.list[0].productSendTimes!.map((t: any) => t.productName);
      expect(names).toContain('스타벅스 아메리카노');
      expect(names).toContain('스타벅스 라떼');
    });

    it('product가 null이면 productName이 "(삭제된 상품)"', async () => {
      const m1 = makeMapping(1, '', 'RESERVE', new Date('2026-07-01T09:00:00'), []);
      const m2 = makeMapping(2, '', 'RESERVE', new Date('2026-07-01T14:00:00'), []);
      m1.product = null as any;
      m2.product = null as any;
      const service = setupService([makeOrder([m1, m2])]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      const names = result.list[0].productSendTimes!.map((t: any) => t.productName);
      expect(names).toEqual(['(삭제된 상품)', '(삭제된 상품)']);
    });

    it('sendRequestAt이 yyyy-MM-ddTHH:mm:ss 포맷으로 변환됨', async () => {
      const mappings = [
        makeMapping(1, '상품A', 'RESERVE', new Date('2026-07-01T09:00:00'), []),
        makeMapping(2, '상품B', 'RESERVE', new Date('2026-07-01T14:30:00'), []),
      ];
      const service = setupService([makeOrder(mappings)]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      const times = result.list[0].productSendTimes!;
      expect(times[0].sendRequestAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      expect(times[1].sendRequestAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    });

    it('미발송 상품의 actualSendAt은 null', async () => {
      const mappings = [
        makeMapping(1, '상품A', 'RESERVE', new Date('2026-07-01T09:00:00'), []),
        makeMapping(2, '상품B', 'RESERVE', new Date('2026-07-01T14:00:00'), []),
      ];
      const service = setupService([makeOrder(mappings)]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      result.list[0].productSendTimes!.forEach((t: any) => {
        expect(t.actualSendAt).toBeNull();
      });
    });

    it('발송 완료 상품의 actualSendAt이 포맷 변환되어 채워짐', async () => {
      const actualDate = new Date('2026-07-01T09:05:00');
      const mappings = [
        makeMapping(1, '상품A', 'RESERVE', new Date('2026-07-01T09:00:00'), [
          makeDelivery(1, IOrderDeliveryStatus.COMPLETE, actualDate),
        ]),
        makeMapping(2, '상품B', 'RESERVE', new Date('2026-07-01T14:00:00'), []),
      ];
      const service = setupService([makeOrder(mappings)]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      const times = result.list[0].productSendTimes!;
      const itemA = times.find((t: any) => t.productName === '상품A')!;
      expect(itemA.actualSendAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      expect(itemA.actualSendAt).not.toBeNull();
    });

    it('FAIL 상태 delivery는 actualSendAt 산정 제외', async () => {
      const mappings = [
        makeMapping(1, '상품A', 'RESERVE', new Date('2026-07-01T09:00:00'), [
          makeDelivery(1, IOrderDeliveryStatus.FAIL, new Date('2026-07-01T09:01:00')),
        ]),
        makeMapping(2, '상품B', 'RESERVE', new Date('2026-07-01T14:00:00'), []),
      ];
      const service = setupService([makeOrder(mappings)]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      const itemA = result.list[0].productSendTimes!.find((t: any) => t.productName === '상품A')!;
      expect(itemA.actualSendAt).toBeNull();
    });
  });

  describe('재발송(resend) — 가장 최근 COMPLETE 건 기준', () => {
    it('재발송이 있을 때 최초 건이 아닌 마지막 COMPLETE 건의 actualSendAt 반환', async () => {
      const firstSendAt = new Date('2026-07-01T09:05:00');
      const resendAt = new Date('2026-07-01T10:30:00');
      const mappings = [
        makeMapping(1, '상품A', 'RESERVE', new Date('2026-07-01T09:00:00'), [
          makeDelivery(1, IOrderDeliveryStatus.FAIL, null),
          makeDelivery(2, IOrderDeliveryStatus.COMPLETE, firstSendAt),
          makeDelivery(3, IOrderDeliveryStatus.COMPLETE, resendAt),
        ]),
        makeMapping(2, '상품B', 'RESERVE', new Date('2026-07-01T14:00:00'), []),
      ];
      const service = setupService([makeOrder(mappings)]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      const itemA = result.list[0].productSendTimes!.find((t: any) => t.productName === '상품A')!;
      // 마지막 COMPLETE = resendAt (10:30), 첫 번째 = 09:05
      expect(itemA.actualSendAt).toContain('10:30');
    });

    it('DB가 id 역순으로 로딩해도 가장 높은 id의 COMPLETE 반환 (정렬 보장 검증)', async () => {
      const firstSendAt = new Date('2026-07-01T09:05:00');
      const resendAt = new Date('2026-07-01T10:30:00');
      const mappings = [
        makeMapping(1, '상품A', 'RESERVE', new Date('2026-07-01T09:00:00'), [
          // 역순 입력: id=3이 배열 앞에 위치 — reverse()만으로는 id=1(FAIL)이 앞에 오는 상황
          makeDelivery(3, IOrderDeliveryStatus.COMPLETE, resendAt),
          makeDelivery(2, IOrderDeliveryStatus.COMPLETE, firstSendAt),
          makeDelivery(1, IOrderDeliveryStatus.FAIL, null),
        ]),
        makeMapping(2, '상품B', 'RESERVE', new Date('2026-07-01T14:00:00'), []),
      ];
      const service = setupService([makeOrder(mappings)]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      const itemA = result.list[0].productSendTimes!.find((t: any) => t.productName === '상품A')!;
      expect(itemA.actualSendAt).toContain('10:30');
    });

    it('COMPLETE_SMS도 유효한 완료 상태로 인정', async () => {
      const smsAt = new Date('2026-07-01T09:10:00');
      const mappings = [
        makeMapping(1, '상품A', 'RESERVE', new Date('2026-07-01T09:00:00'), [
          makeDelivery(1, IOrderDeliveryStatus.COMPLETE_SMS, smsAt),
        ]),
        makeMapping(2, '상품B', 'RESERVE', new Date('2026-07-01T14:00:00'), []),
      ];
      const service = setupService([makeOrder(mappings)]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      const itemA = result.list[0].productSendTimes!.find((t: any) => t.productName === '상품A')!;
      expect(itemA.actualSendAt).not.toBeNull();
    });
  });
});
