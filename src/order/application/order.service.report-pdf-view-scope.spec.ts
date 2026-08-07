import { BadRequestException } from '@nestjs/common';
import { OrderService } from './order.service';
import { IReportSource } from '../interface/report.source';

/**
 * PDF 발행 카운트 경로의 IDOR 방지 (view_scope 검증).
 *
 * 배경: POST /order/delivery-complete/report/pdf 와 /order/order-complete/report/pdf 는
 * 클래스 레벨 AuthUserAuthorizationGuard(=JWT 서명 검증) 하나만 거쳤다. "로그인했나"만 묻고
 * "이 주문이 네 것인가"는 묻지 않아, 아무 계정이나 임의 orderId 로 카운트를 올릴 수 있었다.
 * 같은 컨트롤러의 조회·이력 조회는 이미 검증하는데 **쓰기 경로만** 빠져 있던 비대칭이었다.
 *
 * source 를 DOCUMENT/DIRECT 로 좁힌 것만으로는 닫히지 않는다 — formatReportStatus 가
 * DIRECT 와 EMAIL 을 같은 '발행 완료'로 분기하므로, EMAIL 을 막아도 DIRECT 로 사용자에게
 * 보이는 결과가 동일하다. 경계는 source 축이 아니라 **주문 소유 축**이다.
 *
 * 구현은 develop(#43)의 findDeliveryCompleteOrderInViewScope 다. 이 브랜치도 같은 구멍을
 * 독립적으로 막고 있었으나, 그쪽이 view_scope + 발송완료 상태까지 함께 보는 상위 집합이라
 * 그쪽으로 통일했다.
 *
 * ⚠️ 이 spec 이 존재하는 이유: develop 에는 이 헬퍼를 검증하는 테스트가 **한 건도 없다**
 *    (레포 전수 grep 결과 참조처가 order.service.ts 하나뿐). 발행 카운트가 이 게이트에
 *    올라타 있으므로, 게이트가 조용히 풀리면 이 PR 이 막은 구멍이 그대로 다시 열린다.
 *
 * 여기서 고정하는 계약:
 *  1) 범위 밖 주문이면 400
 *  2) 거부 메시지는 존재 여부를 흘리지 않는다 ('주문이 존재하지 않습니다.')
 *  3) 거부 시 카운트도 activity_log 도 남기지 않는다 (아무 일도 일어나지 않은 상태)
 *  4) 발송완료가 아닌 주문도 거부한다 (develop 이 함께 넣은 상태 게이트)
 *  5) 범위 안 + 발송완료면 종전대로 동작한다 (회귀 없음)
 */

const BASE_USER = { id: 3, email: 'client@example.com' } as any;
const IP = '127.0.0.1';

type SetupOptions = {
  /** applyViewScopeFilter 통과 여부. false 면 getOne 이 null 을 돌려준다. */
  inScope?: boolean;
  /** 주문 상태. DELIVERY_COMPLETE 가 아니면 develop 의 상태 게이트에 걸린다. */
  status?: string;
};

const setupService = ({ inScope = true, status = 'DELIVERY_COMPLETE' }: SetupOptions = {}) => {
  const service = Object.create(OrderService.prototype) as any;
  const order: any = {
    id: 14,
    status,
    deliveryCompleteReportCount: 0,
    deliveryReportLastSource: null,
    orderCompleteReportCount: 0,
    transactionStatementLastSource: null,
  };

  service.orderRepository = {
    createQueryBuilder: jest.fn(() => {
      const qb: any = {
        innerJoin: jest.fn().mockReturnThis(),
        innerJoinAndSelect: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        withDeleted: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(inScope ? 1 : 0),
        getOne: jest.fn().mockResolvedValue(inScope ? order : null),
      };
      return qb;
    }),
    save: jest.fn().mockResolvedValue(order),
  };
  service.userRepository = { findOne: jest.fn().mockResolvedValue({ id: 3, companyId: 1, departmentId: null }) };
  // SELF 스코프 — 기본값이자 실제 고객사 계정의 스코프다. applyViewScopeFilter 가
  // andWhere 를 붙이는 경로(=필터가 실제로 적용되는 경로)를 타게 하는 것이 목적이고,
  // 통과 여부 자체는 getOne 스텁이 대신한다.
  service.userViewScopeRepository = { findOne: jest.fn().mockResolvedValue({ scopeType: 'SELF' }) };
  service.activityLogService = { createLog: jest.fn().mockResolvedValue(1) };

  return { service, order };
};

const METHODS = [
  ['deliveryCompleteReportPdf', 'deliveryCompleteReportCount', 'deliveryReportLastSource'],
  ['orderCompleteReportPdf', 'orderCompleteReportCount', 'transactionStatementLastSource'],
] as const;

describe.each(METHODS)('%s — view_scope 밖 주문', (method, countColumn, sourceColumn) => {
  const call = (service: any) => service[method]({ id: 14, source: IReportSource.DIRECT } as any, BASE_USER, IP);

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

  it('view_scope 필터를 실제로 적용한다 (조회 범위 조회 없이 통과시키지 않는다)', async () => {
    const { service } = setupService({ inScope: false });

    await expect(call(service)).rejects.toBeInstanceOf(BadRequestException);

    expect(service.userViewScopeRepository.findOne).toHaveBeenCalled();
  });
});

describe.each(METHODS)('%s — 발송완료가 아닌 주문', (method, countColumn) => {
  const call = (service: any) => service[method]({ id: 14, source: IReportSource.DIRECT } as any, BASE_USER, IP);

  it('400 으로 거부하고 카운트를 올리지 않는다', async () => {
    const { service, order } = setupService({ status: 'DELIVERY_REQUEST' });

    await expect(call(service)).rejects.toBeInstanceOf(BadRequestException);

    expect(order[countColumn]).toBe(0);
    expect(service.activityLogService.createLog).not.toHaveBeenCalled();
  });
});

describe.each(METHODS)('%s — view_scope 안 + 발송완료 (회귀 없음)', (method, countColumn, sourceColumn) => {
  const call = (service: any) => service[method]({ id: 14, source: IReportSource.DIRECT } as any, BASE_USER, IP);

  it('종전대로 카운트가 오르고 source 가 기록된다', async () => {
    const { service, order } = setupService();

    await call(service);

    expect(order[countColumn]).toBe(1);
    expect(order[sourceColumn]).toBe(IReportSource.DIRECT);
  });

  it('activity_log 도 종전대로 남는다', async () => {
    const { service } = setupService();

    await call(service);

    expect(service.activityLogService.createLog).toHaveBeenCalledTimes(1);
  });
});
