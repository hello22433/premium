import { OrderService } from './order.service';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { IOrderType } from '../interface/order.type';

/**
 * findCancelableDeliveryIds 의 판정 조건 계약을 고정한다.
 *
 * 이 네 조건은 하나라도 조용히 빠지면 "이미 고객에게 간 쿠폰을 취소하고 환불까지 하는" 사고가 된다.
 * 특히 actual_send_at 은 놓치기 쉽다 — 외부 API 경로는 발송에 성공해도 status 가 WAIT 로 남기
 * 때문에 status 만 보면 나간 건을 미발송으로 오판한다.
 * 리팩토링으로 조건이 사라지면 여기서 깨지게 한다.
 */
describe('OrderService.findCancelableDeliveryIds — 취소 대상 판정 조건', () => {
  const setup = () => {
    const calls: string[] = [];
    const params: Record<string, unknown> = {};

    const builder: any = {
      select: () => builder,
      innerJoin: (relation: string, alias: string) => {
        calls.push(`innerJoin:${relation}:${alias}`);
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
      orderBy: () => builder,
      getRawMany: async () => [{ id: 9003 }, { id: 9004 }],
    };

    const sut: any = Object.create(OrderService.prototype);
    sut.orderDeliveryRepository = { createQueryBuilder: () => builder };
    return { sut, calls, params };
  };

  const NOW = new Date('2026-07-22T12:00:00+09:00');

  it('WAIT 상태만 대상으로 한다', async () => {
    const { sut, calls, params } = setup();

    await sut.findCancelableDeliveryIds(1001, NOW);

    expect(calls).toContain('od.status = :wait');
    expect(params.wait).toBe(IOrderDeliveryStatus.WAIT);
  });

  it('실제 발송된 건(actual_send_at)을 제외한다 — 외부 API 는 발송돼도 WAIT 로 남는다', async () => {
    const { sut, calls } = setup();

    await sut.findCancelableDeliveryIds(1001, NOW);

    expect(calls).toContain('od.actualSendAt IS NULL');
  });

  it('배치가 이미 집어간 건(claimed_at)을 제외한다', async () => {
    const { sut, calls } = setup();

    await sut.findCancelableDeliveryIds(1001, NOW);

    expect(calls).toContain('od.claimedAt IS NULL');
  });

  it('실발송 10분 전까지만 허용한다 (cutoff = now + 10분)', async () => {
    const { sut, calls, params } = setup();

    await sut.findCancelableDeliveryIds(1001, NOW);

    expect(calls).toContain('od.sendRequestAt >= :cutoff');
    expect((params.cutoff as Date).getTime()).toBe(NOW.getTime() + 10 * 60 * 1000);
  });

  it('주문 범위로 한정한다', async () => {
    const { sut, calls, params } = setup();

    await sut.findCancelableDeliveryIds(1001, NOW);

    expect(calls).toContain('innerJoin:od.orderProductMapping:opm');
    expect(calls).toContain('opm.orderId = :orderId');
    expect(params.orderId).toBe(1001);
  });

  // 발급 후 발송 직전 크래시 → 재기동 시 releaseStaleBatchClaims 가 claimed_at 을 NULL 로 되돌려
  // status=WAIT / actual_send_at=NULL / claimed_at=NULL 이 된다. 컷오프에 우연히 걸리는 것에
  // 기대지 않고 발급 여부를 직접 본다.
  it('이미 쿠폰이 발급된 건을 제외한다', async () => {
    const { sut, calls } = setup();

    await sut.findCancelableDeliveryIds(1001, NOW);

    expect(calls).toContain('od.couponIssuedAt IS NULL');
  });

  // ★ coupon_issued_at 은 초이스 선택 / 이메일 수령 경로에서만 기록된다. 일반 배치 발송의
  //   PIN 발급은 bar_code 만 채우므로, 그 조건이 없으면 배치 경로에서 발급 가드가 무력해진다.
  it('이미 PIN(bar_code)이 발급된 건을 제외한다 — 배치 발송 경로의 발급 신호', async () => {
    const { sut, calls } = setup();

    await sut.findCancelableDeliveryIds(1001, NOW);

    expect(calls).toContain('od.barCode IS NULL');
  });

  // 발송 배치(claimWaitDeliveries)가 직접 보는 컬럼이다. bar_code IS NULL 이 지금은 같은 행을
  // 간접적으로 걸러 주지만, 그건 "발급되면 bar_code 도 찬다" 는 타 모듈의 암묵 불변식에 기댄 것이라
  // 배치가 보는 컬럼을 여기서도 본다. 이 줄이 지워지면 두 조건집합이 다시 갈라진다.
  it('비동기 리포트 대기(report_state) 건을 제외한다 — 배치와 조건집합 일치', async () => {
    const { sut, calls } = setup();

    await sut.findCancelableDeliveryIds(1001, NOW);

    expect(calls).toContain('od.reportState IS NULL');
  });

  // 외부 API 주문은 배치가 claim 하지 않아 claimed_at 이 영원히 NULL — 조건 3 의 방어력이 0 이다.
  // 배치가 EXTERNAL 을 명시 배제하는 것과 대칭을 맞춘다.
  it('외부 API 주문의 발송건을 제외한다', async () => {
    const { sut, calls, params } = setup();

    await sut.findCancelableDeliveryIds(1001, NOW);

    expect(calls).toContain('innerJoin:opm.order:o');
    expect(calls).toContain('o.type != :externalType');
    expect(params.externalType).toBe(IOrderType.EXTERNAL);
  });

  it('id 목록을 숫자로 반환한다', async () => {
    const { sut } = setup();

    await expect(sut.findCancelableDeliveryIds(1001, NOW)).resolves.toEqual([9003, 9004]);
  });
});
