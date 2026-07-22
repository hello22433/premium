import { OrderService } from './order.service';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';

/**
 * cancelDeliveriesIfStillWaiting 의 조건부 UPDATE(CAS) 계약을 고정한다.
 *
 * 조회 시점과 갱신 시점 사이에 발송 배치가 같은 행을 claim 해 갈 수 있다.
 * WHERE 의 재검사 조건이 하나라도 사라지면 그 경합을 못 잡고, 이미 나가버린 건까지
 * CANCEL 로 덮으면서 환불까지 하게 된다.
 *
 * deleted_at 은 특히 중요하다 — UpdateQueryBuilder 는 SelectQueryBuilder 와 달리
 * soft-delete 필터를 자동으로 붙이지 않는다. 빠지면 삭제된 행도 갱신된다.
 * 근거: typeorm 0.3.28 QueryBuilder.createWhereExpression (queryType === 'select' 조건).
 *
 * 주의: 이 스펙은 mock 에 전달된 조건 문자열만 검사하므로 위 TypeORM 동작 자체는 검증하지 않는다.
 * 라이브러리 업그레이드로 동작이 바뀌어도 이 스펙은 통과한다.
 */
describe('OrderService.cancelDeliveriesIfStillWaiting — 조건부 UPDATE 계약', () => {
  // execute() 결과를 통째로 주입한다. affected 를 기본인자로 받으면 undefined 를 명시로 넘겨도
  // 기본값이 적용돼(JS 기본인자 동작) "affected 부재" 케이스를 표현할 수 없다.
  const setup = (executeResult: { affected?: number } = { affected: 3 }) => {
    const calls: string[] = [];
    const params: Record<string, unknown> = {};
    let setValues: Record<string, unknown> = {};

    const builder: any = {
      update: () => builder,
      set: (v: Record<string, unknown>) => {
        setValues = v;
        return builder;
      },
      where: (cond: string, p?: Record<string, unknown>) => {
        calls.push(cond);
        Object.assign(params, p ?? {});
        return builder;
      },
      andWhere: (cond: string, p?: Record<string, unknown>) => {
        calls.push(cond);
        Object.assign(params, p ?? {});
        return builder;
      },
      execute: async () => executeResult,
    };

    const createQueryBuilder = jest.fn(() => builder);
    const sut: any = Object.create(OrderService.prototype);
    sut.orderDeliveryRepository = { createQueryBuilder };
    return { sut, calls, params, getSetValues: () => setValues, createQueryBuilder };
  };

  const AT = new Date('2026-07-22T12:00:00+09:00');

  it('대상 id 로만 한정한다', async () => {
    const { sut, calls, params } = setup();

    await sut.cancelDeliveriesIfStillWaiting([9003, 9004, 9005], '고객 요청', AT);

    expect(calls).toContain('id IN (:...deliveryIds)');
    expect(params.deliveryIds).toEqual([9003, 9004, 9005]);
  });

  it('갱신 순간에 WAIT / claimed_at / actual_send_at 을 다시 검사한다', async () => {
    const { sut, calls, params } = setup();

    await sut.cancelDeliveriesIfStillWaiting([9003], '고객 요청', AT);

    expect(calls).toContain('status = :wait');
    expect(params.wait).toBe(IOrderDeliveryStatus.WAIT);
    expect(calls).toContain('claimedAt IS NULL');
    expect(calls).toContain('actualSendAt IS NULL');
  });

  it('soft-delete 된 행을 제외한다 (UpdateQueryBuilder 는 자동 적용하지 않는다)', async () => {
    const { sut, calls } = setup();

    await sut.cancelDeliveriesIfStillWaiting([9003], '고객 요청', AT);

    expect(calls).toContain('deletedAt IS NULL');
  });

  it('취소 사유와 시각을 발송건에 남긴다', async () => {
    const { sut, getSetValues } = setup();

    await sut.cancelDeliveriesIfStillWaiting([9003], '고객 요청', AT);

    expect(getSetValues()).toEqual({
      status: IOrderDeliveryStatus.CANCEL,
      cancelReason: '고객 요청',
      canceledAt: AT,
    });
  });

  it('갱신된 행 수를 그대로 돌려준다 (호출자가 경합을 판정할 근거)', async () => {
    const { sut } = setup({ affected: 2 });

    await expect(sut.cancelDeliveriesIfStillWaiting([9003, 9004, 9005], 'r', AT)).resolves.toBe(2);
  });

  it('affected 가 undefined 면 0 으로 본다', async () => {
    const { sut } = setup({});

    await expect(sut.cancelDeliveriesIfStillWaiting([9003], 'r', AT)).resolves.toBe(0);
  });

  it('대상이 없으면 쿼리를 아예 실행하지 않는다', async () => {
    const { sut, createQueryBuilder } = setup();

    await expect(sut.cancelDeliveriesIfStillWaiting([], 'r', AT)).resolves.toBe(0);
    expect(createQueryBuilder).not.toHaveBeenCalled();
  });
});
