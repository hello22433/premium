import { ActivityLogService } from './activity.log.service';
import { IReportSource } from '../../order/interface/report.source';

/**
 * 발행 이력 조회의 actionType 병합 (getOrderReportHistory).
 *
 * 이메일 전송도 발행으로 집계하면서(order.*ReportCount 증가) 정산 목록의 "발행" 버튼이
 * 이메일로만 발행한 건에도 뜬다. 기본 타입만 조회하면 그 버튼이 빈 모달을 연다 —
 * 발행됐다고 표시해 놓고 근거를 못 보여주는 상태.
 *
 * 고정하는 계약:
 *  1) 기본 타입 조회 → 기본 + *_EMAIL actionType 을 함께 조회
 *  2) *_EMAIL 직접 조회(인쇄 화면) → 그 타입만. 기존 동작 보존
 *  3) 파기증명서 이메일 → 대응 기본 타입이 없으므로 단독 조회
 *  4) 이메일 행의 source 는 requestParams 에 없으므로 EMAIL 로 채워 응답한다
 */

const makeService = (rows: any[]) => {
  const service = Object.create(ActivityLogService.prototype) as any;
  const captured: { actionTypes?: string[] } = {};

  const qb: any = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn((_condition: string, params?: Record<string, unknown>) => {
      if (params && 'actionTypes' in params) {
        captured.actionTypes = params.actionTypes as string[];
      }
      return qb;
    }),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
  };

  service.activityLogRepository = { createQueryBuilder: jest.fn(() => qb) };
  return { service, captured };
};

const pdfRow = () => ({
  userEmail: 'ops@enmad.com',
  createdAt: new Date('2026-07-31T10:00:00'),
  actionType: 'DELIVERY_COMPLETE_REPORT',
  requestParams: { orderId: 6142, source: 'DIRECT' },
});

const emailRow = () => ({
  userEmail: 'service01@enmad.com',
  createdAt: new Date('2026-07-31T10:07:44'),
  actionType: 'DELIVERY_COMPLETE_REPORT_EMAIL',
  requestParams: { orderId: 6142, to: 'yjh@example.com', cc: null },
});

describe('getOrderReportHistory — 기본 타입 조회는 이메일 이력도 포함한다', () => {
  it('DELIVERY_COMPLETE_REPORT 조회 시 _EMAIL actionType 도 함께 조회한다', async () => {
    const { service, captured } = makeService([]);

    await service.getOrderReportHistory(6142, 'DELIVERY_COMPLETE_REPORT');

    expect(captured.actionTypes).toEqual(['DELIVERY_COMPLETE_REPORT', 'DELIVERY_COMPLETE_REPORT_EMAIL']);
  });

  it('TRANSACTION_STATEMENT 조회 시 _EMAIL actionType 도 함께 조회한다', async () => {
    const { service, captured } = makeService([]);

    await service.getOrderReportHistory(6142, 'TRANSACTION_STATEMENT');

    expect(captured.actionTypes).toEqual(['TRANSACTION_STATEMENT', 'TRANSACTION_STATEMENT_EMAIL']);
  });

  it('이메일로만 발행한 주문도 이력이 비지 않는다 (빈 모달 방지)', async () => {
    const { service } = makeService([emailRow()]);

    const result = await service.getOrderReportHistory(6142, 'DELIVERY_COMPLETE_REPORT');

    expect(result).toHaveLength(1);
    expect(result[0].to).toBe('yjh@example.com');
  });
});

describe('getOrderReportHistory — 기존 동작 보존', () => {
  it('_EMAIL 을 직접 지정하면 그 타입만 조회한다 (인쇄 화면 경로)', async () => {
    const { service, captured } = makeService([]);

    await service.getOrderReportHistory(6142, 'DELIVERY_COMPLETE_REPORT_EMAIL');

    expect(captured.actionTypes).toEqual(['DELIVERY_COMPLETE_REPORT_EMAIL']);
  });

  it('파기증명서 이메일은 대응 기본 타입이 없어 단독 조회한다', async () => {
    const { service, captured } = makeService([]);

    await service.getOrderReportHistory(6142, 'DESTRUCTION_CERTIFICATE_EMAIL');

    expect(captured.actionTypes).toEqual(['DESTRUCTION_CERTIFICATE_EMAIL']);
  });
});

describe('getOrderReportHistory — source 투영', () => {
  it('PDF 경로는 저장된 source 를 그대로 반환한다', async () => {
    const { service } = makeService([pdfRow()]);

    const result = await service.getOrderReportHistory(6142, 'DELIVERY_COMPLETE_REPORT');

    expect(result[0].source).toBe('DIRECT');
  });

  it('이메일 경로는 requestParams 에 source 가 없어도 EMAIL 로 채운다', async () => {
    const { service } = makeService([emailRow()]);

    const result = await service.getOrderReportHistory(6142, 'DELIVERY_COMPLETE_REPORT');

    expect(result[0].source).toBe(IReportSource.EMAIL);
  });

  it('두 경로가 섞여 있어도 각각의 source 로 구분된다', async () => {
    const { service } = makeService([emailRow(), pdfRow()]);

    const result = await service.getOrderReportHistory(6142, 'DELIVERY_COMPLETE_REPORT');

    expect(result.map((r: any) => r.source)).toEqual([IReportSource.EMAIL, 'DIRECT']);
  });
});
