jest.mock('typeorm-transactional', () => ({
  ...jest.requireActual('typeorm-transactional'),
  Transactional: () => () => undefined,
  runOnTransactionCommit: (cb: () => void) => cb(),
}));

import { BadRequestException } from '@nestjs/common';
import { OrderService } from './order.service';
import { IUserAuthority } from '../../user/interface/user.authority';
import { ViewScopeType } from '../../entity/user.view.scope.entity';

/**
 * 발송취소 엔드포인트의 소유권(조회범위) 검증 — 관리자 리뷰 P1 보안.
 *
 * /order/delivery-cancel 은 클래스 가드가 JWT 유효성만 보고, 서비스의 order.userId 조건도 주석
 * 처리돼 있었다. **부분취소 경로는 user 를 받지도 않았다.** 그래서 인증된 아무 사용자나 주문 id 만
 * 알면 타 테넌트의 예약 발송을 취소(+환불)시킬 수 있었다.
 *
 * 여기서 고정하는 계약:
 *  1) 조회범위 밖 주문이면 취소 로직에 진입하기 전에 거부한다 — 전체취소·부분취소 **양쪽 모두**.
 *  2) 거부 시 주문 행 잠금·부분취소 경로가 아예 호출되지 않는다(자금 경로 미진입).
 *  3) 범위 안이면 종전대로 진행한다(기존 동작 보존 — 고객사 본인 취소를 막지 않는다).
 *
 * ※ 검증 기준은 조회 API 와 동일한 applyViewScopeFilter(assertOrderInViewScope)다.
 *   발송확정 권한(canTransitionDelivery)을 쓰지 않는 이유는 그 술어가 SUPER/OPERATION 전용이라
 *   자기 주문을 취소하던 고객사(CORPORATE_ADMIN)까지 막아 동작이 바뀌기 때문이다.
 */
describe('OrderService.deliveryCancel — 소유권(조회범위) 검증', () => {
  const ORDER_ID = 4242;

  /**
   * assertOrderInViewScope 가 실제로 쓰는 쿼리 체인을 흉내낸다.
   * applyViewScopeFilter 가 붙인 SELF 소유권 조건을 대상 주문에 평가해 getCount 를 흉내낸다.
   */
  const buildSut = (orderOwnerUserId: number) => {
    let inScope = true;
    const scopeBuilder: any = {
      innerJoin: jest.fn(() => scopeBuilder),
      withDeleted: jest.fn(() => scopeBuilder),
      where: jest.fn(() => scopeBuilder),
      andWhere: jest.fn((clause: string, params: Record<string, unknown>) => {
        if (clause.includes('order.userId = :userId')) {
          inScope = orderOwnerUserId === params.userId;
        }
        return scopeBuilder;
      }),
      getCount: jest.fn(async () => (inScope ? 1 : 0)),
    };

    const lockBuilder: any = {
      setLock: jest.fn(() => lockBuilder),
      leftJoinAndSelect: jest.fn(() => lockBuilder),
      where: jest.fn(() => lockBuilder),
      getOne: jest.fn(async () => null), // 여기 도달하면 '주문 없음' 으로 끝난다(진입 여부만 본다)
    };

    const sut: any = Object.create(OrderService.prototype);
    // 첫 호출(소유권 검증)과 이후 호출(주문 잠금)을 구분해 돌려준다.
    let call = 0;
    sut.orderRepository = {
      createQueryBuilder: jest.fn(() => {
        call += 1;
        return call === 1 ? scopeBuilder : lockBuilder;
      }),
    };
    sut.userRepository = {
      findOne: jest.fn().mockResolvedValue({ id: 10, companyId: 100, departmentId: 5 }),
    };
    sut.userViewScopeRepository = {
      findOne: jest.fn().mockResolvedValue({ scopeType: ViewScopeType.SELF, getDeptIdList: () => [] }),
    };
    sut.partialDeliveryCancel = jest.fn().mockResolvedValue({ canceledIds: [], refundedAmount: 0, remaining: 0 });
    return { sut, lockBuilder };
  };

  const caller = { id: 10, email: 'me@x.com', authority: IUserAuthority.CORPORATE_ADMIN };
  const body = (deliveryIds?: number[]) => ({ id: ORDER_ID, cancelReason: '고객 요청', deliveryIds }) as any;

  describe('조회범위 밖 주문 (타 테넌트)', () => {
    it('부분취소: 거부하고 partialDeliveryCancel 을 호출하지 않는다', async () => {
      const { sut } = buildSut(999); // 주문 소유자가 호출자(10)가 아니다

      await expect(sut.deliveryCancel(caller, body([9001, 9002]))).rejects.toBeInstanceOf(BadRequestException);

      expect(sut.partialDeliveryCancel).not.toHaveBeenCalled();
    });

    it('전체취소: 거부하고 주문 행 잠금까지 가지 않는다', async () => {
      const { sut, lockBuilder } = buildSut(999);

      await expect(sut.deliveryCancel(caller, body())).rejects.toBeInstanceOf(BadRequestException);

      expect(lockBuilder.setLock).not.toHaveBeenCalled();
    });
  });

  describe('조회범위 안 주문 (본인 주문)', () => {
    it('부분취소: 검증을 통과해 부분취소 경로로 넘어간다', async () => {
      const { sut } = buildSut(10); // 호출자가 소유자

      await sut.deliveryCancel(caller, body([9001]));

      expect(sut.partialDeliveryCancel).toHaveBeenCalledWith(ORDER_ID, [9001], '고객 요청');
    });

    it('전체취소: 검증을 통과해 주문 행 잠금으로 넘어간다', async () => {
      const { sut, lockBuilder } = buildSut(10);

      // 잠금 조회가 null 을 돌려주므로 '주문 없음' 으로 끝나지만, 여기까지 왔다는 것이 통과의 증거다.
      await expect(sut.deliveryCancel(caller, body())).rejects.toBeInstanceOf(BadRequestException);

      expect(lockBuilder.setLock).toHaveBeenCalled();
    });
  });
});
