import { BadRequestException } from '@nestjs/common';
import { OrderService } from './order.service';
import { IReportSource } from '../interface/report.source';
import { IUserAuthority } from '../../user/interface/user.authority';

/**
 * PDF 발행 카운트 경로의 IDOR 방지 (view_scope 검증).
 *
 * 배경: POST /order/delivery-complete/report/pdf 와 /order/order-complete/report/pdf 는
 * 클래스 레벨 AuthUserAuthorizationGuard(=JWT 서명 검증) 하나만 거쳤다. "로그인했나"만 묻고
 * "이 주문이 네 것인가"는 묻지 않아, 아무 계정이나 임의 orderId 로 카운트를 올릴 수 있었다.
 * 같은 컨트롤러의 조회(getOrderCompleteReport)·이력 조회(report-history)는 이미 검증하는데
 * **쓰기 경로만** 빠져 있던 비대칭이다.
 *
 * source 를 DOCUMENT/DIRECT 로 좁힌 것만으로는 닫히지 않는다 — formatReportStatus 가
 * DIRECT 와 EMAIL 을 같은 '발행 완료'로 분기하므로, EMAIL 을 막아도 DIRECT 로 사용자에게
 * 보이는 결과가 동일하다. 경계는 source 축이 아니라 **주문 소유 축**이다.
 *
 * 막으려는 것은 **고객사 계정이 남의 회사 주문 상태를 뒤집는 것**이다. 운영자 이상은 면제한다 —
 * 이메일 발송 3종이 이미 AuthUserSuperAndOperationAdminGuard 를 요구하고, 프론트의 정산 발행
 * 화면도 permission: [SUPER_ADMIN, OPERATION_ADMIN] 이다. 같은 선을 옮겨 적는 것이다.
 *
 * 여기서 고정하는 계약:
 *  1) 고객사 계정 + 범위 밖 주문이면 카운트도 activity_log 도 남기지 않고 400
 *  2) 거부 메시지는 존재 여부를 흘리지 않는다 ('주문이 존재하지 않습니다.')
 *  3) 범위 안이면 종전대로 동작한다 (회귀 없음)
 *  4) 검증은 **본체 조회보다 먼저** 돈다 (범위 밖이면 주문 로드 자체를 하지 않는다)
 *  5) **SUPER_ADMIN / OPERATION_ADMIN 은 범위 밖이어도 통과** — view_scope 조회 자체를 하지 않는다
 */

const CORPORATE_USER = { id: 3, email: 'client@example.com', authority: IUserAuthority.CORPORATE_ADMIN } as any;
const IP = '127.0.0.1';

type SetupOptions = {
  /** assertOrderInViewScope 의 getCount 결과. 0 이면 범위 밖. */
  inScope?: boolean;
};

const setupService = ({ inScope = true }: SetupOptions = {}) => {
  const service = Object.create(OrderService.prototype) as any;
  const order: any = {
    id: 14,
    deliveryCompleteReportCount: 0,
    deliveryReportLastSource: null,
    orderCompleteReportCount: 0,
    transactionStatementLastSource: null,
  };

  // createQueryBuilder 호출 순서를 기록한다. assertOrderInViewScope 가 먼저 돌았는지
  // (= 범위 밖일 때 본체 조회를 아예 하지 않는지) 확인하는 데 쓴다.
  const builtQueries: string[] = [];
  service.orderRepository = {
    createQueryBuilder: jest.fn(() => {
      const qb: any = {
        innerJoin: jest.fn(() => {
          builtQueries.push('viewScopeCheck');
          return qb;
        }),
        innerJoinAndSelect: jest.fn(() => {
          builtQueries.push('loadOrder');
          return qb;
        }),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        withDeleted: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(inScope ? 1 : 0),
        getOne: jest.fn().mockResolvedValue(order),
      };
      return qb;
    }),
    save: jest.fn().mockResolvedValue(order),
  };
  service.userRepository = { findOne: jest.fn().mockResolvedValue({ id: 3, companyId: 1, departmentId: null }) };
  // SELF 스코프를 쓴다 — 기본값이자 실제 고객사 계정의 스코프다. 범위 판정 자체는
  // getCount 스텁이 대신하므로, 여기서는 applyViewScopeFilter 가 andWhere 를 붙이는
  // 경로(=필터가 실제로 적용되는 경로)를 타게 하는 것이 목적이다.
  service.userViewScopeRepository = { findOne: jest.fn().mockResolvedValue({ scopeType: 'SELF' }) };
  service.activityLogService = { createLog: jest.fn().mockResolvedValue(1) };

  return { service, order, builtQueries };
};

describe.each([
  ['deliveryCompleteReportPdf', 'deliveryCompleteReportCount', 'deliveryReportLastSource'],
  ['orderCompleteReportPdf', 'orderCompleteReportCount', 'transactionStatementLastSource'],
] as const)('%s — view_scope 밖 주문', (method, countColumn, sourceColumn) => {
  const call = (service: any) => service[method]({ id: 14, source: IReportSource.DIRECT } as any, CORPORATE_USER, IP);

  it('400 으로 거부한다', async () => {
    const { service } = setupService({ inScope: false });

    await expect(call(service)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('존재 여부를 흘리지 않는 메시지를 쓴다', async () => {
    const { service } = setupService({ inScope: false });

    await expect(call(service)).rejects.toThrow('주문이 존재하지 않습니다.');
  });

  it('카운트를 올리지 않는다 (정산 목록이 뒤집히지 않는다)', async () => {
    const { service, order } = setupService({ inScope: false });

    await expect(call(service)).rejects.toBeInstanceOf(BadRequestException);

    expect(order[countColumn]).toBe(0);
    expect(order[sourceColumn]).toBeNull();
    expect(service.orderRepository.save).not.toHaveBeenCalled();
  });

  it('activity_log 도 남기지 않는다 (아무 일도 일어나지 않은 상태)', async () => {
    const { service } = setupService({ inScope: false });

    await expect(call(service)).rejects.toBeInstanceOf(BadRequestException);

    expect(service.activityLogService.createLog).not.toHaveBeenCalled();
  });

  it('본체 조회보다 먼저 검증한다 (범위 밖이면 주문을 로드하지 않는다)', async () => {
    const { service, builtQueries } = setupService({ inScope: false });

    await expect(call(service)).rejects.toBeInstanceOf(BadRequestException);

    expect(builtQueries).toEqual(['viewScopeCheck']);
  });
});

describe.each([
  ['deliveryCompleteReportPdf', 'deliveryCompleteReportCount', 'deliveryReportLastSource'],
  ['orderCompleteReportPdf', 'orderCompleteReportCount', 'transactionStatementLastSource'],
] as const)('%s — view_scope 안 주문 (회귀 없음)', (method, countColumn, sourceColumn) => {
  const call = (service: any) => service[method]({ id: 14, source: IReportSource.DIRECT } as any, CORPORATE_USER, IP);

  it('종전대로 카운트가 오르고 source 가 기록된다', async () => {
    const { service, order } = setupService({ inScope: true });

    await call(service);

    expect(order[countColumn]).toBe(1);
    expect(order[sourceColumn]).toBe(IReportSource.DIRECT);
  });

  it('activity_log 도 종전대로 남는다', async () => {
    const { service } = setupService({ inScope: true });

    await call(service);

    expect(service.activityLogService.createLog).toHaveBeenCalledTimes(1);
  });
});

/**
 * 운영자 이상은 view_scope 면제.
 *
 * 운영관리자는 자기가 배정되지 않은 주문의 리포트도 발행한다 — 정산 목록(settle.service)이
 * view_scope 를 적용하지 않아 전체를 보여주기 때문이고 그것이 정상 동선이다.
 * 운영 DB 실측에서 범위 밖 발행 54건이 전부 OPERATION_ADMIN 2명이었다(고객사는 0건).
 * 면제하지 않으면 그 사용이 그대로 400 이 된다.
 */
describe.each([
  [IUserAuthority.SUPER_ADMIN, 'deliveryCompleteReportPdf', 'deliveryCompleteReportCount'],
  [IUserAuthority.SUPER_ADMIN, 'orderCompleteReportPdf', 'orderCompleteReportCount'],
  [IUserAuthority.OPERATION_ADMIN, 'deliveryCompleteReportPdf', 'deliveryCompleteReportCount'],
  [IUserAuthority.OPERATION_ADMIN, 'orderCompleteReportPdf', 'orderCompleteReportCount'],
] as const)('%s — %s 는 view_scope 밖이어도 통과한다', (authority, method, countColumn) => {
  const adminUser = { id: 19, email: 'ops@enmad.com', authority } as any;
  const call = (service: any) => service[method]({ id: 14, source: IReportSource.DIRECT } as any, adminUser, IP);

  it('범위 밖(getCount=0)이어도 카운트가 오른다', async () => {
    const { service, order } = setupService({ inScope: false });

    await call(service);

    expect(order[countColumn]).toBe(1);
  });

  it('view_scope 조회 자체를 하지 않는다 (불필요한 쿼리 3개 절약)', async () => {
    const { service, builtQueries } = setupService({ inScope: false });

    await call(service);

    expect(builtQueries).toEqual(['loadOrder']);
    expect(service.userViewScopeRepository.findOne).not.toHaveBeenCalled();
  });
});
