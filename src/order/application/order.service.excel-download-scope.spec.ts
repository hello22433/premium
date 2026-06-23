import { OrderService } from './order.service';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IOrderSection } from '../interface/order.section';
import { IOrderType } from '../interface/order.type';
import { ViewScopeType } from '../../entity/user.view.scope.entity';

jest.mock('exceljs');
jest.mock('../../util/file.util', () => ({
  createExportTempPath: jest.fn().mockReturnValue('/tmp/test-order.xlsx'),
}));

describe('OrderService excelDownload scope', () => {
  const user = { id: 10, email: 'owner@test.com', authority: IUserAuthority.CORPORATE_ADMIN };

  const createBuilder = () => {
    const clauses: string[] = [];
    const orderBys: Array<[string, string]> = [];
    const cloneBuilder: any = {
      select: jest.fn().mockReturnThis(),
      distinct: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
      getMany: jest.fn().mockResolvedValue([]),
      clone: jest.fn(),
    };
    cloneBuilder.clone.mockReturnValue(cloneBuilder);

    const builder: any = {
      clauses,
      orderBys,
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      withDeleted: jest.fn().mockReturnThis(),
      where: jest.fn((clause: string) => {
        clauses.push(clause);
        return builder;
      }),
      andWhere: jest.fn((clause: string) => {
        clauses.push(clause);
        return builder;
      }),
      orderBy: jest.fn((column: string, direction: string) => {
        orderBys.push([column, direction]);
        return builder;
      }),
      clone: jest.fn().mockReturnValue(cloneBuilder),
    };
    return builder;
  };

  const buildService = (scopeType: ViewScopeType) => {
    const service = Object.create(OrderService.prototype) as any;
    const builder = createBuilder();
    service.orderRepository = { createQueryBuilder: jest.fn().mockReturnValue(builder) };
    service.userRepository = {
      findOne: jest.fn().mockResolvedValue({ id: 10, companyId: 100, departmentId: 5 }),
    };
    service.userViewScopeRepository = {
      findOne: jest.fn().mockResolvedValue({ scopeType, getDeptIdList: () => [] }),
    };
    service.activityLogService = {
      verifyPassword: jest.fn().mockResolvedValue(undefined),
      createLog: jest.fn().mockResolvedValue(undefined),
    };
    service.applyDirectSendingFilter = jest.fn();
    const ExcelJS = jest.requireMock('exceljs') as any;
    ExcelJS.stream = {
      xlsx: {
        WorkbookWriter: jest.fn().mockImplementation(() => ({
          addWorksheet: jest.fn().mockReturnValue({
            set columns(_: any) {},
            commit: jest.fn().mockResolvedValue(undefined),
          }),
          commit: jest.fn().mockResolvedValue(undefined),
        })),
      },
    };
    return { service, builder };
  };

  const baseBody = {
    searchType: 'ALL',
    searchKeyword: '',
    type: IOrderType.GENERAL,
    status: undefined,
    startAt: undefined,
    endAt: undefined,
    password: 'pw',
    downloadReason: 'reason',
    sendingType: undefined,
    dateType: undefined,
  } as any;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(0);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('주문 엑셀 다운로드는 목록 조회와 같은 SELF view_scope 조건을 적용한다', async () => {
    const { service, builder } = buildService(ViewScopeType.SELF);

    await service.excelDownload(user, { ...baseBody, section: IOrderSection.ORDER }, { ipAddress: '', userAgent: '' });

    expect(builder.clauses).toContain('order.deletedAt IS NULL');
    expect(builder.clauses).toContain(
      '(order.userId = :userId OR order.operationUserId = :userId OR (order.clientUserId = :userId AND order.apiAppId IS NULL))',
    );
    expect(builder.orderBys).toContainEqual(['order.id', 'DESC']);
  });

  it('발송 엑셀 다운로드는 TEMP 제외 조건과 view_scope 조건을 함께 적용한다', async () => {
    const { service, builder } = buildService(ViewScopeType.SELF);

    await service.excelDownload(
      user,
      { ...baseBody, section: IOrderSection.SHIPPING },
      { ipAddress: '', userAgent: '' },
    );

    expect(builder.clauses).toContain('order.status != :tempStatus');
    expect(builder.clauses).toContain(
      '(order.userId = :userId OR order.operationUserId = :userId OR (order.clientUserId = :userId AND order.apiAppId IS NULL))',
    );
  });

  it('회사 범위 엑셀 다운로드는 회사 view_scope 조건을 적용한다', async () => {
    const { service, builder } = buildService(ViewScopeType.COMPANY);

    await service.excelDownload(user, { ...baseBody, section: IOrderSection.ORDER }, { ipAddress: '', userAgent: '' });

    expect(builder.clauses).toContain('user.companyId = :companyId');
  });
});
