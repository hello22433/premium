import { BadRequestException } from '@nestjs/common';
import { OrderService } from './order.service';
import { IUserAuthority } from '../../user/interface/user.authority';
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
      settleCondition: null,
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
          inScope =
            order.userId === uid || order.operationUserId === uid || order.clientUserId === uid;
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
  });
});
