import { BadRequestException } from '@nestjs/common';
import { OrderService } from './order.service';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserStatus } from '../../user/interface/user.status';
import { ViewScopeType } from '../../entity/user.view.scope.entity';

/**
 * IDOR 회귀 방지: GET /order/detail/:id 는 호출자의 view_scope 범위 안의 주문만 조회 가능해야 한다.
 *
 * getDetail 은 applyViewScopeFilter 로 query builder 에 소유권/조회범위 WHERE 를 추가한 뒤
 * getOne() 으로 주문을 가져온다. 범위를 벗어난 주문은 SQL 단계에서 걸러져 getOne() 이 null 을
 * 반환하고 → not-found(BadRequestException) 로 거부된다.
 *
 * 이 테스트는 실제 DB 없이, mock query builder 가 캡처한 scope WHERE 절을 대상 주문에 평가하여
 * getOne() 결과를 시뮬레이션한다.
 */
describe('OrderService getDetail view-scope (IDOR)', () => {
  // 주문 소유자: userId=10 (operationUser/clientUser 없음).
  // orderProductMappings 가 비어 있어 상세 매핑(복호화/이미지 등) 루프는 건너뛰고
  // 최종 응답 객체 구성에 필요한 최소 필드만 채운다.
  const ownedOrder = {
    id: 77,
    userId: 10,
    operationUserId: null,
    clientUserId: null,
    companyId: 100,
    departmentId: 5,
    orderProductMappings: [],
    registerAt: new Date('2026-01-01T00:00:00Z'),
    eventName: 'evt',
    type: 'GENERAL',
    status: 'TEMP',
    cancelReason: null,
    canceledAt: null,
    clientUserId2: null,
    user: {
      settlePeriodCondition: null,
      settlePeriodCount: null,
      settleCondition: 'PRE_PAYMENT',
    },
  } as any;

  /**
   * applyViewScopeFilter 가 호출하는 andWhere 들을 캡처하고,
   * SELF 스코프의 소유권 조건(order.userId/operationUserId/clientUserId = :userId)을
   * 대상 주문에 평가하여 getOne() 결과를 시뮬레이션하는 mock builder.
   */
  const createScopeAwareQueryBuilder = (order: typeof ownedOrder) => {
    let inScope = true;
    const builder: any = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      withDeleted: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      andWhere: jest.fn((clause: string, params: Record<string, unknown>) => {
        // SELF 스코프: 본인/배정/담당 고객만 통과
        if (clause.includes('order.userId = :userId')) {
          const uid = params.userId;
          inScope = order.userId === uid || order.operationUserId === uid || order.clientUserId === uid;
        }
        return builder;
      }),
      getOne: jest.fn(() => Promise.resolve(inScope ? order : null)),
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
      // 기본 스코프 = SELF
      findOne: jest.fn().mockResolvedValue({ scopeType: ViewScopeType.SELF, getDeptIdList: () => [] }),
    };
    // recoverDeletedProducts/cryptoCipher 등 상세 매핑 단계는 본 테스트 범위 밖이라
    // no-op 으로 둔다 (소유자 분기에서 빈 productList 로 정상 반환).
    service.recoverDeletedProducts = jest.fn().mockResolvedValue(undefined);
    service.walletAccountResolverService = {
      resolveForOrder: jest.fn().mockResolvedValue({ settleCondition: 'POST_PAYMENT' }),
    };
    return service;
  };

  it('소유자가 아니고 조회 범위 밖인 사용자는 거부된다 (BadRequestException, not-found)', async () => {
    const service = buildService(ownedOrder);
    const intruder = { id: 999, email: 'x@x.com', authority: IUserAuthority.CORPORATE_ADMIN };

    await expect(service.getDetail(intruder, { id: 77 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('소유자(in-scope)는 주문 조회에 성공한다', async () => {
    const service = buildService(ownedOrder);
    const owner = { id: 10, email: 'o@o.com', authority: IUserAuthority.CORPORATE_ADMIN };

    const result = await service.getDetail(owner, { id: 77 });
    expect(result).toBeDefined();
    expect(result.id).toBe(77);
    expect(result.isPreSettle).toBe(false);
    expect(service.walletAccountResolverService.resolveForOrder).toHaveBeenCalledWith(ownedOrder);
  });

  it('이벤트 상세도 계정이 아닌 정산코드 wallet의 정산조건을 사용한다', async () => {
    const service = buildService(ownedOrder);
    const owner = { id: 10, email: 'o@o.com', authority: IUserAuthority.CORPORATE_ADMIN };

    const result = await service.getEventDetail(owner, { id: 77 });

    expect(result.isPreSettle).toBe(false);
    expect(service.walletAccountResolverService.resolveForOrder).toHaveBeenCalledWith(ownedOrder);
  });
});

/**
 * ssgBalanceCheck 노출 게이트 회귀 방지: 민감 재무데이터(행사잔액·SSG 집계금액)는
 * 발송확정 권한자(운영자/최고관리자)에게만 노출. 고객사/비소유자는 조회 자체를 호출하지
 * 않고 필드도 omit 되어야 한다. (shouldExposeSsgBalanceCheck 게이트의 service-level 단언)
 */
describe('OrderService getDetail ssgBalanceCheck 노출 게이트', () => {
  // SSG + 검토완료 + userId=10 소유 주문 (호출자 id=10 → scope 통과)
  const ssgReviewOrder = {
    id: 77,
    userId: 10,
    operationUserId: null,
    clientUserId: null,
    companyId: 100,
    departmentId: 5,
    orderProductMappings: [],
    registerAt: new Date('2026-01-01T00:00:00Z'),
    eventName: 'evt',
    type: 'SSG',
    status: 'REVIEW_COMPLETE',
    cancelReason: null,
    canceledAt: null,
    clientUserId2: null,
    user: { settlePeriodCondition: null, settlePeriodCount: null, settleCondition: null },
  } as any;

  const buildSsgService = (transitionAuthority: IUserAuthority) => {
    let inScope = true;
    const builder: any = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      withDeleted: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      andWhere: jest.fn((clause: string, params: Record<string, unknown>) => {
        if (clause.includes('order.userId = :userId')) {
          const uid = params.userId;
          inScope =
            ssgReviewOrder.userId === uid ||
            ssgReviewOrder.operationUserId === uid ||
            ssgReviewOrder.clientUserId === uid;
        }
        return builder;
      }),
      getOne: jest.fn(() => Promise.resolve(inScope ? ssgReviewOrder : null)),
    };
    const service = Object.create(OrderService.prototype) as any;
    service.orderRepository = { createQueryBuilder: jest.fn().mockReturnValue(builder) };
    service.userViewScopeRepository = {
      findOne: jest.fn().mockResolvedValue({ scopeType: ViewScopeType.SELF, getDeptIdList: () => [] }),
    };
    service.recoverDeletedProducts = jest.fn().mockResolvedValue(undefined);
    // 게이트가 보는 호출자 권한 (발송확정 권한 판정 입력)
    service.getCurrentDeliveryTransitionUser = jest.fn().mockResolvedValue({
      id: 10,
      authority: transitionAuthority,
      status: IUserStatus.USED,
      authorityList: null,
    });
    const checkSpy = jest.fn().mockResolvedValue({ hasWarning: true, lookupFailed: false, events: [] });
    service.ssgEventService = { getSsgBalanceCheckForOrder: checkSpy };
    service.walletAccountResolverService = {
      resolveForOrder: jest.fn().mockResolvedValue({ settleCondition: 'POST_PAYMENT' }),
    };
    // scope 필터 내부 userRepository.findOne (companyId/departmentId 용)
    service.userRepository = {
      findOne: jest.fn().mockResolvedValue({ id: 10, companyId: 100, departmentId: 5 }),
    };
    return { service, checkSpy };
  };

  it('발송확정 권한 운영자: ssgBalanceCheck 노출 + getSsgBalanceCheckForOrder 호출', async () => {
    const { service, checkSpy } = buildSsgService(IUserAuthority.OPERATION_ADMIN);
    const operator = { id: 10, email: 'op@x.com', authority: IUserAuthority.OPERATION_ADMIN };

    const result = await service.getDetail(operator, { id: 77 });

    expect(checkSpy).toHaveBeenCalledWith(77);
    expect(result.ssgBalanceCheck).toEqual({ hasWarning: true, lookupFailed: false, events: [] });
  });

  it('고객사(CORPORATE_ADMIN) 소유자: 미호출 + ssgBalanceCheck omit', async () => {
    const { service, checkSpy } = buildSsgService(IUserAuthority.CORPORATE_ADMIN);
    const corp = { id: 10, email: 'c@x.com', authority: IUserAuthority.CORPORATE_ADMIN };

    const result = await service.getDetail(corp, { id: 77 });

    expect(checkSpy).not.toHaveBeenCalled();
    expect(result.ssgBalanceCheck).toBeUndefined();
  });
});
