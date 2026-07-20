import { BadRequestException } from '@nestjs/common';
import { OrderService } from './order.service';
import { IUserAuthority } from '../../user/interface/user.authority';
import { ViewScopeType } from '../../entity/user.view.scope.entity';

/**
 * 테스트 발송(testDelivery) 정책 검증:
 *  - 운영관리자/최고관리자는 상품당 2회 제한을 우회한다 (횟수제한 예외로 막히지 않음).
 *  - 기업관리자(CORPORATE_ADMIN)는 상품당 2회 제한이 유지된다.
 *  - orderId 와 orderProductMapping.orderId 불일치(IDOR) 는 거부된다.
 *  - assertOrderInViewScope 로 조회 범위 밖 주문은 거부된다.
 *
 * 실제 DB 없이 mock repository 로 앞단 가드(스코프/불일치/횟수제한)만 평가한다.
 * 가드 통과 케이스는 이후 무거운 발송 경로(이미지 생성 등)에서 별도 이유로 실패하므로,
 * "횟수제한 예외 메시지로는 막히지 않음" 을 확인하는 방식으로 우회를 검증한다.
 */
describe('OrderService testDelivery 정책 (횟수제한/IDOR)', () => {
  const LIMIT_MSG = '테스트발송은 상품당 최대 2회입니다.';
  const MISMATCH_MSG = '주문 정보와 상품 정보가 일치하지 않습니다.';

  // 주문 소유자 userId=10, 주문 id=77.
  const ownedOrder = {
    id: 77,
    userId: 10,
    operationUserId: null,
    clientUserId: null,
  };

  /** assertOrderInViewScope 용 scope-aware order query builder. */
  const createScopeBuilder = () => {
    let inScope = true;
    const builder: any = {
      innerJoin: jest.fn().mockReturnThis(),
      withDeleted: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn((clause: string, params: Record<string, unknown>) => {
        if (clause.includes('order.userId = :userId')) {
          const uid = params.userId;
          inScope = ownedOrder.userId === uid || ownedOrder.operationUserId === uid || ownedOrder.clientUserId === uid;
        }
        return builder;
      }),
      getCount: jest.fn(() => Promise.resolve(inScope ? 1 : 0)),
    };
    return builder;
  };

  /** orderProductMapping 조회 builder. testDeliveryCount/ orderId 를 주입한다. */
  const createMappingBuilder = (mapping: any) => {
    const builder: any = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(() => Promise.resolve(mapping)),
    };
    return builder;
  };

  const buildService = (mapping: any) => {
    const service = Object.create(OrderService.prototype) as any;
    service.orderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(createScopeBuilder()),
    };
    service.orderProductMappingRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(createMappingBuilder(mapping)),
    };
    service.userRepository = {
      findOne: jest.fn().mockResolvedValue({ id: undefined, companyId: 100, departmentId: 5 }),
    };
    service.userViewScopeRepository = {
      findOne: jest.fn().mockResolvedValue({ scopeType: ViewScopeType.SELF, getDeptIdList: () => [] }),
    };
    return service;
  };

  const owner = (authority: IUserAuthority) => ({ id: 10, email: 'o@o.com', authority });
  const body = (over?: Partial<{ orderId: number; orderProductMappingId: number; deliveryTarget: string }>) => ({
    orderId: 77,
    orderProductMappingId: 5,
    deliveryTarget: '01012345678',
    ...over,
  });

  it('기업관리자: testDeliveryCount 가 2 이상이면 횟수제한으로 거부된다', async () => {
    const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 2 });
    await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(LIMIT_MSG);
  });

  it('운영관리자: testDeliveryCount 가 2 이상이어도 횟수제한 예외로는 막히지 않는다 (우회)', async () => {
    const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 99 });
    // 횟수제한 가드를 지나 이후 발송 경로에서 실패하더라도, 그 메시지는 LIMIT_MSG 가 아니어야 한다.
    await expect(service.testDelivery(owner(IUserAuthority.OPERATION_ADMIN), body())).rejects.not.toThrow(LIMIT_MSG);
  });

  it('최고관리자: testDeliveryCount 가 2 이상이어도 횟수제한 예외로는 막히지 않는다 (우회)', async () => {
    const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 99 });
    await expect(service.testDelivery(owner(IUserAuthority.SUPER_ADMIN), body())).rejects.not.toThrow(LIMIT_MSG);
  });

  it('IDOR: mapping.orderId 가 요청 orderId 와 다르면 거부된다', async () => {
    const service = buildService({ id: 5, orderId: 88, testDeliveryCount: 0 });
    await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(MISMATCH_MSG);
  });

  it('스코프 밖 호출자(주문 미소유)는 assertOrderInViewScope 에서 거부된다', async () => {
    const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 });
    const intruder = { id: 999, email: 'x@x.com', authority: IUserAuthority.CORPORATE_ADMIN };
    await expect(service.testDelivery(intruder, body())).rejects.toBeInstanceOf(BadRequestException);
  });
});
