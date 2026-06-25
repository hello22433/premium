import { BadRequestException } from '@nestjs/common';
import { OrderService } from './order.service';
import { IUserAuthority } from '../../user/interface/user.authority';
import { ViewScopeType } from '../../entity/user.view.scope.entity';

/**
 * IDOR 회귀 방지 (D3-19): getDetail 형제 조회 API들도 호출자의 view_scope 범위 안의
 * 주문만 다루어야 한다. 각 메서드는 applyViewScopeFilter 로 소유권/조회범위 WHERE 를 추가한 뒤
 * getOne()/getMany()/getCount() 로 주문을 가져오므로, 범위 밖 주문은 SQL 단계에서 걸러져
 * not-found(BadRequestException) 로 거부된다.
 *
 * 실제 DB 없이, mock query builder 가 캡처한 SELF 스코프의 소유권 조건을 대상 주문에 평가하여
 * 결과(getOne/getMany/getCount)를 시뮬레이션한다. (getdetail-scope.spec.ts 패턴 확장)
 */
describe('OrderService 조회 형제 메서드 view-scope (IDOR, D3-19)', () => {
  // 주문 소유자: userId=10 (operationUser/clientUser 없음), 발송완료 상태.
  const ownedOrder = {
    id: 77,
    userId: 10,
    operationUserId: null,
    clientUserId: null,
    companyId: 100,
    departmentId: 5,
    status: 'DELIVERY_COMPLETE',
    orderProductMappings: [],
    user: { companyId: 100 },
    clientUser: null,
  } as any;

  /** applyViewScopeFilter 의 SELF 소유권 andWhere 를 평가해 in/out scope 를 판정하는 mock builder. */
  const createScopeAwareQueryBuilder = (order: typeof ownedOrder) => {
    let inScope = true;
    const builder: any = {
      select: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      withDeleted: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      andWhere: jest.fn((clause: string, params: Record<string, unknown>) => {
        if (clause.includes('order.userId = :userId')) {
          const uid = params.userId;
          inScope = order.userId === uid || order.operationUserId === uid || order.clientUserId === uid;
        }
        return builder;
      }),
      getOne: jest.fn(() => Promise.resolve(inScope ? order : null)),
      getMany: jest.fn(() => Promise.resolve(inScope ? [order] : [])),
      getCount: jest.fn(() => Promise.resolve(inScope ? 1 : 0)),
    };
    return builder;
  };

  const buildService = (order: typeof ownedOrder) => {
    const service = Object.create(OrderService.prototype) as any;
    service.orderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(createScopeAwareQueryBuilder(order)),
    };
    service.userRepository = {
      findOne: jest.fn().mockResolvedValue({ id: undefined, companyId: 100, departmentId: 5 }),
    };
    service.userViewScopeRepository = {
      findOne: jest.fn().mockResolvedValue({ scopeType: ViewScopeType.SELF, getDeptIdList: () => [] }),
    };
    service.recoverDeletedProducts = jest.fn().mockResolvedValue(undefined);
    return service;
  };

  const intruder = { id: 999, email: 'x@x.com', authority: IUserAuthority.CORPORATE_ADMIN };

  it('getEventDetail: 범위 밖 호출자는 거부된다', async () => {
    const service = buildService(ownedOrder);
    await expect(service.getEventDetail(intruder, { id: 77 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('getDeliveryCompleteReport: 범위 밖 호출자는 거부된다', async () => {
    const service = buildService(ownedOrder);
    await expect(service.getDeliveryCompleteReport({ id: 77, unmasked: false }, intruder)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('getOrderCompleteReport: 범위 밖 호출자는 거부된다', async () => {
    const service = buildService(ownedOrder);
    await expect(service.getOrderCompleteReport({ id: 77 }, intruder)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('getDeliveryCompleteReportMultiple: 범위 밖 주문ID 묶음은 결과 0건 → 거부', async () => {
    const service = buildService(ownedOrder);
    await expect(service.getDeliveryCompleteReportMultiple('77', undefined, intruder, false)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('getOrderCompleteReportMultiple: 범위 밖 주문ID 묶음은 결과 0건 → 거부', async () => {
    const service = buildService(ownedOrder);
    await expect(service.getOrderCompleteReportMultiple('77', undefined, intruder)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('assertOrderInViewScope: 범위 밖이면 throw, 범위 안이면 통과 (report-history 가드)', async () => {
    const outService = buildService(ownedOrder);
    await expect(outService.assertOrderInViewScope(intruder, 77)).rejects.toBeInstanceOf(BadRequestException);

    const inService = buildService(ownedOrder);
    const owner = { id: 10, email: 'o@o.com', authority: IUserAuthority.CORPORATE_ADMIN };
    await expect(inService.assertOrderInViewScope(owner, 77)).resolves.toBeUndefined();
  });

  it('report-multiple 혼합 요청(내 주문 + 범위 밖 id)은 부분 성공 없이 전체 거부된다', async () => {
    // owner 는 77 만 소유 → ids=77,88 요청 시 88 이 scope 필터로 결과서 빠짐
    // → missingIds 검사로 부분 증빙 생성 대신 전체 거부 (응답 orderIds 불일치 방지)
    const owner = { id: 10, email: 'o@o.com', authority: IUserAuthority.CORPORATE_ADMIN };

    const svcA = buildService(ownedOrder);
    await expect(svcA.getOrderCompleteReportMultiple('77,88', undefined, owner)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    const svcB = buildService(ownedOrder);
    await expect(svcB.getDeliveryCompleteReportMultiple('77,88', undefined, owner, false)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
