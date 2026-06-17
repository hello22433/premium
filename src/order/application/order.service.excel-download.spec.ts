import { BadRequestException } from '@nestjs/common';
import { OrderService } from './order.service';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';
import { IOrderSection } from '../interface/order.section';
import { IUserAuthority } from '../../user/interface/user.authority';

/**
 * D3-34 스트리밍 전환 검증: id수집→청크재조회 후 행 수·상품명·발송수량 보존
 */

jest.mock('exceljs');
jest.mock('../../util/file.util', () => ({
  createExportTempPath: jest.fn().mockReturnValue('/tmp/test-order.xlsx'),
}));

const BASE_USER = {
  id: 1,
  email: 'admin@test.com',
  authority: IUserAuthority.SUPER_ADMIN,
} as any;

const BASE_BODY = {
  type: IOrderType.GENERAL,
  section: IOrderSection.ORDER,
  password: 'pw',
  downloadReason: '감사',
  searchType: 'ALL',
  searchKeyword: '',
  sendingType: null,
  dateType: null,
  startAt: undefined,
  endAt: undefined,
  status: undefined,
} as any;

const BASE_META = { ipAddress: '1.2.3.4', userAgent: 'TestAgent/1.0' };

const makeOrder = (id: number, products: Array<{ name: string; amount: number }>, sendAmount: number) => ({
  id,
  registerAt: new Date('2026-06-01T09:00:00'),
  status: IOrderStatus.DELIVERY_COMPLETE,
  eventName: '테스트이벤트',
  sendAmount,
  settleAmount: sendAmount,
  clientUserId: null,
  clientUser: null,
  operationUser: null,
  // snapshot 필드로 user FK 없이 billing 읽기
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
  orderProductMappings: products.map((p, idx) => ({
    id: idx + 1,
    amount: p.amount,
    product: { name: p.name },
    orderDeliveries: [],
  })),
});

const setupService = (orders: any[]) => {
  const capturedRows: any[] = [];
  const createLogMock = jest.fn().mockResolvedValue(undefined);

  const ExcelJS = jest.requireMock('exceljs') as any;
  ExcelJS.stream = {
    xlsx: {
      WorkbookWriter: jest.fn().mockImplementation(() => ({
        addWorksheet: jest.fn().mockReturnValue({
          set columns(_: any) {},
          addRow: jest.fn().mockImplementation((row: any) => {
            capturedRows.push({ ...row });
            return { commit: jest.fn() };
          }),
          commit: jest.fn().mockResolvedValue(undefined),
        }),
        commit: jest.fn().mockResolvedValue(undefined),
      })),
    },
  };

  const idRows = orders.map((o) => ({ id: String(o.id) }));

  // clone()이 반환하는 qb — ID수집(getRawMany)과 청크재조회(getMany) 모두 지원
  const clonedQb: any = {
    select: jest.fn().mockReturnThis(),
    distinct: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(idRows),
    getMany: jest.fn().mockResolvedValue(orders),
    clone: jest.fn(),
  };
  clonedQb.clone.mockReturnValue(clonedQb);

  const qb: any = {
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    withDeleted: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    clone: jest.fn().mockReturnValue(clonedQb),
  };

  const service = Object.create(OrderService.prototype) as any;
  service.orderRepository = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
  service.activityLogService = {
    verifyPassword: jest.fn().mockResolvedValue(undefined),
    createLog: createLogMock,
  };
  service.logger = { debug: jest.fn(), warn: jest.fn(), log: jest.fn() };
  service['applyDirectSendingFilter'] = jest.fn();
  service['applyOrderDateCondition'] = jest.fn().mockReturnValue(qb);

  return { service, capturedRows, createLogMock, clonedQb };
};

describe('OrderService excelDownload — D3-34 스트리밍 전환 검증', () => {
  describe('기간 가드 (assertExcelExportRangeWithinYears)', () => {
    it('3년 초과 기간 요청 시 BadRequestException 발생', async () => {
      const { service } = setupService([]);
      await expect(
        service.excelDownload(BASE_USER, { ...BASE_BODY, startAt: '2020-01-01', endAt: '2023-01-02' }, BASE_META),
      ).rejects.toThrow(BadRequestException);
    });

    it('정확히 3년 이내 기간은 정상 통과', async () => {
      const { service } = setupService([]);
      await expect(
        service.excelDownload(BASE_USER, { ...BASE_BODY, startAt: '2023-06-17', endAt: '2026-06-17' }, BASE_META),
      ).resolves.not.toThrow();
    });
  });

  describe('단일 상품 주문', () => {
    it('productName이 첫 번째 상품명으로 기록됨', async () => {
      const orders = [makeOrder(1, [{ name: '스타벅스 아메리카노', amount: 2 }], 9800)];
      const { service, capturedRows } = setupService(orders);

      await service.excelDownload(BASE_USER, BASE_BODY, BASE_META);

      expect(capturedRows).toHaveLength(1);
      expect(capturedRows[0].productName).toBe('스타벅스 아메리카노');
    });

    it('sendAmount가 주문 원본값 그대로 기록됨', async () => {
      const orders = [makeOrder(1, [{ name: '상품A', amount: 3 }], 15000)];
      const { service, capturedRows } = setupService(orders);

      await service.excelDownload(BASE_USER, BASE_BODY, BASE_META);

      expect(capturedRows[0].sendAmount).toBe(15000);
    });

    it('totalAmount가 orderProductMappings.amount 합계로 기록됨', async () => {
      const orders = [makeOrder(1, [{ name: '상품A', amount: 5 }], 25000)];
      const { service, capturedRows } = setupService(orders);

      await service.excelDownload(BASE_USER, BASE_BODY, BASE_META);

      expect(capturedRows[0].totalAmount).toBe(5);
    });
  });

  describe('복수 상품 주문', () => {
    it('"외 N건" suffix가 정확히 붙음 (2개 상품 → 외 1건)', async () => {
      const orders = [
        makeOrder(1, [{ name: '상품A', amount: 1 }, { name: '상품B', amount: 2 }], 30000),
      ];
      const { service, capturedRows } = setupService(orders);

      await service.excelDownload(BASE_USER, BASE_BODY, BASE_META);

      expect(capturedRows[0].productName).toBe('상품A외 1건');
    });

    it('totalAmount가 전체 상품 amount 합계로 기록됨', async () => {
      const orders = [
        makeOrder(1, [{ name: '상품A', amount: 3 }, { name: '상품B', amount: 4 }, { name: '상품C', amount: 5 }], 60000),
      ];
      const { service, capturedRows } = setupService(orders);

      await service.excelDownload(BASE_USER, BASE_BODY, BASE_META);

      expect(capturedRows[0].totalAmount).toBe(12);
    });
  });

  describe('삭제된 상품', () => {
    it('product가 null이면 productName이 "(삭제된 상품)"으로 기록됨', async () => {
      const order = makeOrder(1, [], 10000);
      order.orderProductMappings = [{ id: 1, amount: 1, product: null, orderDeliveries: [] }] as any;
      const { service, capturedRows } = setupService([order]);

      await service.excelDownload(BASE_USER, BASE_BODY, BASE_META);

      expect(capturedRows[0].productName).toBe('(삭제된 상품)');
    });
  });

  describe('행 수 보존 (recordCount)', () => {
    it('주문 3건 → recordCount 3이 createLog에 전달됨', async () => {
      const orders = [
        makeOrder(1, [{ name: '상품A', amount: 1 }], 5000),
        makeOrder(2, [{ name: '상품B', amount: 2 }], 10000),
        makeOrder(3, [{ name: '상품C', amount: 3 }], 15000),
      ];
      const { service, capturedRows, createLogMock } = setupService(orders);

      await service.excelDownload(BASE_USER, BASE_BODY, BASE_META);

      expect(capturedRows).toHaveLength(3);
      expect(createLogMock).toHaveBeenCalledWith(expect.objectContaining({ recordCount: 3 }));
    });

    it('주문 0건 → recordCount 0이 createLog에 전달됨', async () => {
      const { service, createLogMock } = setupService([]);

      await service.excelDownload(BASE_USER, BASE_BODY, BASE_META);

      expect(createLogMock).toHaveBeenCalledWith(expect.objectContaining({ recordCount: 0 }));
    });
  });

  describe('청크 분리', () => {
    it('501건 주문 시 청크 재조회가 2회 실행됨', async () => {
      const orders = Array.from({ length: 501 }, (_, i) =>
        makeOrder(i + 1, [{ name: `상품${i}`, amount: 1 }], 5000),
      );
      // getMany는 청크당 해당 주문만 반환해야 하지만 mock 단순화:
      // 첫 청크(500) / 두 번째 청크(1)만 검증
      const { service, clonedQb } = setupService(orders);

      // 첫 getMany: 500건, 두 번째: 1건 반환하도록 순서 지정
      clonedQb.getMany
        .mockResolvedValueOnce(orders.slice(0, 500))
        .mockResolvedValueOnce(orders.slice(500));

      await service.excelDownload(BASE_USER, BASE_BODY, BASE_META);

      expect(clonedQb.getMany).toHaveBeenCalledTimes(2);
    });
  });

  describe('IP/UA 기록 (D3-33)', () => {
    it('meta의 ipAddress와 userAgent가 createLog에 전달됨', async () => {
      const orders = [makeOrder(1, [{ name: '상품A', amount: 1 }], 5000)];
      const { service, createLogMock } = setupService(orders);
      const meta = { ipAddress: '10.0.0.1', userAgent: 'Chrome/125' };

      await service.excelDownload(BASE_USER, BASE_BODY, meta);

      expect(createLogMock).toHaveBeenCalledWith(
        expect.objectContaining({ ipAddress: '10.0.0.1', userAgent: 'Chrome/125' }),
      );
    });
  });
});
