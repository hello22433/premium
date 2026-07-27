jest.mock('typeorm-transactional', () => ({
  Transactional: () => () => undefined,
}));

jest.mock('exceljs', () => ({
  Workbook: jest.fn().mockImplementation(() => ({
    addWorksheet: jest.fn().mockReturnValue({
      columns: [],
      addRow: jest.fn(),
    }),
    xlsx: {
      writeFile: jest.fn().mockResolvedValue(undefined),
    },
  })),
}));

import { OrderRealProductService } from './order.real.product.service';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IOrderSection } from '../../order/interface/order.section';
import { CryptoCipher } from '../../common/infra/crypto.cipher';

const cipherStub = {
  encryptAccountNumber: (v: string) => v,
  safeDecryptAccountNumber: (v: string) => v,
  encryptDeliveryTarget: (v: string) => v,
  safeDecryptDeliveryTarget: (v: string) => v,
} as unknown as CryptoCipher;

const createService = () => {
  const andWhereCalls: Array<[string, Record<string, unknown>?]> = [];

  const qb: any = {
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn((clause: string, params?: Record<string, unknown>) => {
      andWhereCalls.push([clause, params]);
      return qb;
    }),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  };

  const service = Object.create(OrderRealProductService.prototype) as any;
  service.orderRepository = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
  service.activityLogService = {
    verifyPassword: jest.fn().mockResolvedValue(undefined),
    createLog: jest.fn().mockResolvedValue(undefined),
  };
  service.cryptoCipher = cipherStub;

  return { service, andWhereCalls };
};

const baseBody = {
  section: IOrderSection.SHIPPING,
  password: 'pw',
  downloadReason: 'test',
  startAt: '2024-01-01',
  endAt: '2024-12-31',
};

describe('OrderRealProductService excelDownload SHIPPING 섹션 스코프', () => {
  it('SUPER_ADMIN은 userId 필터 없이 전체 주문을 조회한다', async () => {
    const { service, andWhereCalls } = createService();

    await service.excelDownload({ id: 1, authority: IUserAuthority.SUPER_ADMIN }, baseBody);

    const hasUserIdFilter = andWhereCalls.some(([clause]) => clause.includes('order.userId'));
    expect(hasUserIdFilter).toBe(false);
  });

  it('OPERATION_ADMIN은 본인이 등록한 주문으로 제한한다', async () => {
    const { service, andWhereCalls } = createService();

    await service.excelDownload({ id: 42, authority: IUserAuthority.OPERATION_ADMIN }, baseBody);

    expect(andWhereCalls).toContainEqual(['order.userId = :userId', { userId: 42 }]);
  });

  it('CORPORATE_ADMIN은 본인 고객사 주문으로 제한하고 userId 필터는 추가되지 않는다', async () => {
    const { service, andWhereCalls } = createService();

    await service.excelDownload({ id: 99, authority: IUserAuthority.CORPORATE_ADMIN }, baseBody);

    expect(andWhereCalls).toContainEqual(['order.businessUserId = :userId', { userId: 99 }]);
    const hasUserIdFilter = andWhereCalls.some(([clause]) => clause.includes('order.userId'));
    expect(hasUserIdFilter).toBe(false);
  });
});
