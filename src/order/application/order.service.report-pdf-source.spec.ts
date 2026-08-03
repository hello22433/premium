import { OrderService } from './order.service';
import { IReportSource } from '../interface/report.source';

/**
 * PDF 발행 경로의 source 기록 일관성.
 *
 * 컬럼(order.*LastSource)과 activity_log(requestParams.source)는 같은 발행 사건의 두 기록이다.
 * 각자 계산하면 source 미전송 시 컬럼은 DOCUMENT, 로그는 undefined 가 되어 어긋난다 —
 * 이력 조회에서 '발행경로'가 빈칸으로 나오고, 프론트는 이를 레거시 null 행과 구별하지 못한다.
 *
 * 두 기록이 항상 같은 값을 쓰는 것을 고정한다.
 */

const BASE_USER = { id: 3, email: 'ops@enmad.com' } as any;
const IP = '127.0.0.1';

const setupService = () => {
  const service = Object.create(OrderService.prototype) as any;
  const order: any = {
    id: 14,
    deliveryCompleteReportCount: 0,
    deliveryReportLastSource: null,
    orderCompleteReportCount: 0,
    transactionStatementLastSource: null,
  };

  // 두 메서드는 본체 조회 전에 assertOrderInViewScope 를 부른다(IDOR 방지).
  // 그 메서드도 orderRepository.createQueryBuilder 를 쓰므로 innerJoin/withDeleted/getCount
  // 까지 갖춘 스텁이 필요하다. 여기서는 "범위 안"(getCount=1)을 전제로 두고,
  // 범위 밖 거부는 order.service.report-pdf-view-scope.spec.ts 가 따로 고정한다.
  service.orderRepository = {
    createQueryBuilder: jest.fn(() => ({
      innerJoin: jest.fn().mockReturnThis(),
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      withDeleted: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(1),
      getOne: jest.fn().mockResolvedValue(order),
    })),
    save: jest.fn().mockResolvedValue(order),
  };
  service.userRepository = { findOne: jest.fn().mockResolvedValue({ id: 3, companyId: 1, departmentId: null }) };
  service.userViewScopeRepository = { findOne: jest.fn().mockResolvedValue({ scopeType: 'ALL' }) };
  service.activityLogService = { createLog: jest.fn().mockResolvedValue(1) };

  return { service, order };
};

const loggedSource = (service: any) => service.activityLogService.createLog.mock.calls[0][0].requestParams.source;

describe('deliveryCompleteReportPdf — 컬럼과 로그의 source 가 일치한다', () => {
  it.each([IReportSource.DIRECT, IReportSource.DOCUMENT])('%s 를 보내면 양쪽 다 그 값', async (source) => {
    const { service, order } = setupService();

    await service.deliveryCompleteReportPdf({ id: 14, source } as any, BASE_USER, IP);

    expect(order.deliveryReportLastSource).toBe(source);
    expect(loggedSource(service)).toBe(source);
  });

  it('source 미전송이면 양쪽 다 DOCUMENT 로 기록한다 (로그만 undefined 로 남지 않는다)', async () => {
    const { service, order } = setupService();

    await service.deliveryCompleteReportPdf({ id: 14 } as any, BASE_USER, IP);

    expect(order.deliveryReportLastSource).toBe(IReportSource.DOCUMENT);
    expect(loggedSource(service)).toBe(IReportSource.DOCUMENT);
  });

  it('컬럼과 로그가 서로 다른 값을 갖지 않는다', async () => {
    const { service, order } = setupService();

    await service.deliveryCompleteReportPdf({ id: 14 } as any, BASE_USER, IP);

    expect(loggedSource(service)).toBe(order.deliveryReportLastSource);
  });

  it('카운트를 1 증가시킨다', async () => {
    const { service, order } = setupService();

    await service.deliveryCompleteReportPdf({ id: 14, source: IReportSource.DIRECT } as any, BASE_USER, IP);

    expect(order.deliveryCompleteReportCount).toBe(1);
  });
});

describe('orderCompleteReportPdf — 컬럼과 로그의 source 가 일치한다', () => {
  it('source 미전송이면 양쪽 다 DOCUMENT 로 기록한다', async () => {
    const { service, order } = setupService();

    await service.orderCompleteReportPdf({ id: 14 } as any, BASE_USER, IP);

    expect(order.transactionStatementLastSource).toBe(IReportSource.DOCUMENT);
    expect(loggedSource(service)).toBe(IReportSource.DOCUMENT);
  });

  it('DIRECT 를 보내면 양쪽 다 DIRECT', async () => {
    const { service, order } = setupService();

    await service.orderCompleteReportPdf({ id: 14, source: IReportSource.DIRECT } as any, BASE_USER, IP);

    expect(order.transactionStatementLastSource).toBe(IReportSource.DIRECT);
    expect(loggedSource(service)).toBe(IReportSource.DIRECT);
  });
});
