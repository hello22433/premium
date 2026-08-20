import { OrderService } from './order.service';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';
import { IOrderSection } from '../interface/order.section';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { ViewScopeType } from '../../entity/user.view.scope.entity';

/**
 * getList() — productSendTimes 필드 검증
 * 배열 채움 게이트: 혼합 발송(IMMEDIATE+RESERVE) 또는 RESERVE 분 단위 distinct ≥ 2.
 * 게이트 통과 시 배열 = RESERVE ∪ IMMEDIATE 전 매핑 (각 항목 sendType 포함, Case-G 포함).
 * per-mapping actualSendAt은 활성(deletedAt == null) 배송 중 actualSendAt MAX (상태 무관).
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

const makeDelivery = (
  id: number,
  status: IOrderDeliveryStatus,
  actualSendAt: Date | null,
  replacedFromId: number | null = null,
) => ({
  id,
  status,
  actualSendAt,
  resendAt: null,
  replacedFromId,
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

    it('IMMEDIATE+RESERVE 혼재(RESERVE 동일 분 슬롯)면 혼합 게이트로 배열 채움 + 즉시상품 포함', async () => {
      const mappings = [
        makeMapping(1, '즉시상품', 'IMMEDIATE', null, []),
        makeMapping(2, '예약A', 'RESERVE', new Date('2026-07-01T09:00:00'), []),
        makeMapping(3, '예약B', 'RESERVE', new Date('2026-07-01T09:00:00'), []),
      ];
      const service = setupService([makeOrder(mappings)]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      const times = result.list[0].productSendTimes!;
      // 혼합(IMMEDIATE≥1 AND RESERVE≥1) → RESERVE distinct=1이어도 채워짐, 전 매핑 포함
      expect(times).toHaveLength(3);
      expect(times.map((t: any) => t.productName)).toContain('즉시상품');
    });

    it('IMMEDIATE+RESERVE 혼재 시 배열에 즉시상품도 포함(반전)', async () => {
      const mappings = [
        makeMapping(1, '즉시상품', 'IMMEDIATE', null, []),
        makeMapping(2, '예약A', 'RESERVE', new Date('2026-07-01T09:00:00'), []),
        makeMapping(3, '예약B', 'RESERVE', new Date('2026-07-01T14:00:00'), []),
      ];
      const service = setupService([makeOrder(mappings)]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      const times = result.list[0].productSendTimes!;
      expect(times).toHaveLength(3);
      expect(times.map((t: any) => t.productName)).toContain('즉시상품');
      const immediate = times.find((t: any) => t.productName === '즉시상품')!;
      expect(immediate.sendType).toBe('IMMEDIATE');
      expect(immediate.sendRequestAt).toBeNull();
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

    it('FAIL 상태여도 actualSendAt 이 있으면 산정 포함', async () => {
      const mappings = [
        makeMapping(1, '상품A', 'RESERVE', new Date('2026-07-01T09:00:00'), [
          makeDelivery(1, IOrderDeliveryStatus.FAIL, new Date('2026-07-01T09:01:00')),
        ]),
        makeMapping(2, '상품B', 'RESERVE', new Date('2026-07-01T14:00:00'), []),
      ];
      const service = setupService([makeOrder(mappings)]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      const itemA = result.list[0].productSendTimes!.find((t: any) => t.productName === '상품A')!;
      expect(itemA.actualSendAt).toContain('09:01');
    });
  });

  describe('재발송(resend) — 활성 배송 MAX actualSendAt 기준', () => {
    it('재발송이 있을 때 최초 건이 아닌 가장 최근 actualSendAt 반환', async () => {
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

    it('id 높은 delivery가 더 이른 시각일 때 actualSendAt 최댓값 반환 (병렬 발송 순서 역전 검증)', async () => {
      // 병렬 발송: id=3이 먼저 완료(09:05), id=2가 나중 완료(10:30) — id 순서 ≠ 완료 시각 순서
      const earlierSendAt = new Date('2026-07-01T09:05:00');
      const laterSendAt = new Date('2026-07-01T10:30:00');
      const mappings = [
        makeMapping(1, '상품A', 'RESERVE', new Date('2026-07-01T09:00:00'), [
          makeDelivery(1, IOrderDeliveryStatus.FAIL, null),
          makeDelivery(2, IOrderDeliveryStatus.COMPLETE, laterSendAt),
          makeDelivery(3, IOrderDeliveryStatus.COMPLETE, earlierSendAt),
        ]),
        makeMapping(2, '상품B', 'RESERVE', new Date('2026-07-01T14:00:00'), []),
      ];
      const service = setupService([makeOrder(mappings)]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      const itemA = result.list[0].productSendTimes!.find((t: any) => t.productName === '상품A')!;
      // id DESC 기준이면 id=3(09:05) 반환 → 틀림. actualSendAt MAX 기준이면 10:30 반환 → 맞음
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

  describe('폐기후재발행(discard-reissue) — replacedFromId 필터', () => {
    it('폐기후재발행(replacedFromId != null) 행은 actualSendAt MAX 에서 제외', async () => {
      const originalSendAt = new Date('2026-07-24T10:00:00');
      const reissueSendAt = new Date('2026-08-19T14:14:15');
      const mappings = [
        makeMapping(1, '상품A', 'RESERVE', new Date('2026-07-24T09:00:00'), [
          makeDelivery(1, IOrderDeliveryStatus.COMPLETE, originalSendAt),
          makeDelivery(2, IOrderDeliveryStatus.COMPLETE, reissueSendAt, 1),
        ]),
        makeMapping(2, '상품B', 'RESERVE', new Date('2026-07-24T14:00:00'), []),
      ];
      const service = setupService([makeOrder(mappings)]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      expect(result.list[0].actualSendAt).toContain('07-24');
      expect(result.list[0].actualSendAt).not.toContain('08-19');
      const itemA = result.list[0].productSendTimes!.find((t: any) => t.productName === '상품A')!;
      expect(itemA.actualSendAt).toContain('07-24');
    });
  });

  describe('혼합 발송유형(IMMEDIATE+RESERVE) — 게이트 및 배열', () => {
    it('혼합 RESERVE1(9:00) + IMMEDIATE1 → 길이 2, 각 항목 sendType/sendRequestAt 정확', async () => {
      const mappings = [
        makeMapping(1, '예약상품', 'RESERVE', new Date('2026-07-01T09:00:00'), []),
        makeMapping(2, '즉시상품', 'IMMEDIATE', null, []),
      ];
      const service = setupService([makeOrder(mappings)]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      const times = result.list[0].productSendTimes!;
      expect(times).toHaveLength(2);
      const reserve = times.find((t: any) => t.productName === '예약상품')!;
      const immediate = times.find((t: any) => t.productName === '즉시상품')!;
      expect(reserve.sendType).toBe('RESERVE');
      expect(reserve.sendRequestAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      expect(immediate.sendType).toBe('IMMEDIATE');
      expect(immediate.sendRequestAt).toBeNull();
    });

    it('Case-G: RESERVE(9:00) + draft RESERVE(null) + IMMEDIATE1 → draft 포함, draft sendRequestAt null', async () => {
      const mappings = [
        makeMapping(1, '예약상품', 'RESERVE', new Date('2026-07-01T09:00:00'), []),
        makeMapping(2, 'draft예약', 'RESERVE', null, []),
        makeMapping(3, '즉시상품', 'IMMEDIATE', null, []),
      ];
      const service = setupService([makeOrder(mappings)]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      const times = result.list[0].productSendTimes!;
      expect(times).toHaveLength(3);
      const draft = times.find((t: any) => t.productName === 'draft예약')!;
      expect(draft.sendType).toBe('RESERVE');
      expect(draft.sendRequestAt).toBeNull();
    });

    it('Case-G(즉시1 + slot 없는 draft RESERVE1): 혼합 게이트로 채워짐, 배열 길이=매핑수', async () => {
      const mappings = [
        makeMapping(1, '즉시상품', 'IMMEDIATE', null, []),
        makeMapping(2, 'draft예약', 'RESERVE', null, []),
      ];
      const service = setupService([makeOrder(mappings)]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      const times = result.list[0].productSendTimes!;
      expect(times).toHaveLength(2);
    });

    it('IMMEDIATE 재발송 COMPLETE/COMPLETE_SMS actualSendAt은 가장 최근 값', async () => {
      const firstSendAt = new Date('2026-07-01T09:05:00');
      const resendAt = new Date('2026-07-01T10:30:00');
      const mappings = [
        makeMapping(1, '즉시상품', 'IMMEDIATE', null, [
          makeDelivery(1, IOrderDeliveryStatus.COMPLETE, firstSendAt),
          makeDelivery(2, IOrderDeliveryStatus.COMPLETE_SMS, resendAt),
        ]),
        makeMapping(2, '예약상품', 'RESERVE', new Date('2026-07-01T09:00:00'), []),
      ];
      const service = setupService([makeOrder(mappings)]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      const immediate = result.list[0].productSendTimes!.find((t: any) => t.productName === '즉시상품')!;
      expect(immediate.actualSendAt).toContain('10:30');
    });

    it('§5 비혼합 draft 확장: RESERVE 2슬롯 + draft RESERVE(null), IMMEDIATE 0 → 길이 3, draft null/RESERVE', async () => {
      const mappings = [
        makeMapping(1, '예약A', 'RESERVE', new Date('2026-07-01T09:00:00'), []),
        makeMapping(2, '예약B', 'RESERVE', new Date('2026-07-01T10:00:00'), []),
        makeMapping(3, 'draft예약', 'RESERVE', null, []),
      ];
      const service = setupService([makeOrder(mappings)]);
      const result = await service.getList(BASE_USER, BASE_QUERY);
      const times = result.list[0].productSendTimes!;
      expect(times).toHaveLength(3);
      const draft = times.find((t: any) => t.productName === 'draft예약')!;
      expect(draft.sendRequestAt).toBeNull();
      expect(draft.sendType).toBe('RESERVE');
    });
  });
});
