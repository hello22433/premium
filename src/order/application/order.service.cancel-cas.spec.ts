import { ConflictException, InternalServerErrorException } from '@nestjs/common';
import { OrderService } from './order.service';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { IOrderType } from '../interface/order.type';

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
  // execute() 결과를 주입한다. 생략하면 "요청한 만큼 갱신됨"(성공)이 기본이다 —
  // 고정 숫자를 기본값으로 두면 id 개수가 다른 케이스마다 불일치가 나서 의도치 않게 실패한다.
  // 명시로 넘길 때만 불일치/부재 케이스가 된다(옵셔널이라 undefined 도 표현 가능).
  const setup = (executeResult?: { affected?: number }) => {
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
      execute: async () => executeResult ?? { affected: (params.deliveryIds as number[] | undefined)?.length ?? 0 },
    };

    const createQueryBuilder = jest.fn(() => builder);
    const sut: any = Object.create(OrderService.prototype);
    sut.orderDeliveryRepository = { createQueryBuilder };
    sut.logger = { error: jest.fn(), log: jest.fn(), warn: jest.fn() };
    return { sut, calls, params, getSetValues: () => setValues, createQueryBuilder };
  };

  const ORDER_ID = 1001;
  const AT = new Date('2026-07-22T12:00:00+09:00');

  it('대상 id 로만 한정한다', async () => {
    const { sut, calls, params } = setup();

    await sut.cancelDeliveriesIfStillWaiting(ORDER_ID, [9003, 9004, 9005], '고객 요청', AT);

    expect(calls).toContain('id IN (:...deliveryIds)');
    expect(params.deliveryIds).toEqual([9003, 9004, 9005]);
  });

  // ★ deliveryIds 는 결국 요청 바디에서 온 값이다. id IN (...) 만으로는 이 함수가 그 값을
  //   무조건 신뢰하게 되고, 남의 주문 발송건 id 를 섞어 보내면 그 건이 취소되면서
  //   환불은 요청자의 주문 기준으로 일어난다(IDOR + 자금 결함).
  //   실DB 로 확인함: 남의 orderId → affected 0, 올바른 orderId → affected 1.
  it('주문 범위를 벗어난 발송건은 취소하지 않는다 (orderId 스코프)', async () => {
    const { sut, calls, params } = setup();

    await sut.cancelDeliveriesIfStillWaiting(ORDER_ID, [9003], '고객 요청', AT);

    expect(calls).toContain(
      'EXISTS (SELECT 1 FROM order_product_mapping opm JOIN `order` o ON o.id = opm.order_id ' +
        'WHERE opm.id = order_delivery.order_product_mapping_id AND opm.order_id = :orderId ' +
        'AND o.type != :externalType)',
    );
    expect(params.orderId).toBe(ORDER_ID);
    // EXTERNAL 주문 배제도 같은 EXISTS 안에서 재검증한다(조회 단계와 동일 조건집합).
    expect(params.externalType).toBe(IOrderType.EXTERNAL);
  });

  it('갱신 순간에 WAIT / claimed_at / actual_send_at 을 다시 검사한다', async () => {
    const { sut, calls, params } = setup();

    await sut.cancelDeliveriesIfStillWaiting(ORDER_ID, [9003], '고객 요청', AT);

    expect(calls).toContain('status = :wait');
    expect(params.wait).toBe(IOrderDeliveryStatus.WAIT);
    expect(calls).toContain('claimedAt IS NULL');
    expect(calls).toContain('actualSendAt IS NULL');
  });

  // ★ 관리자 리뷰 HIGH: 조회 단계(findCancelableDeliveryIds)가 보는 발급/진행 신호를 갱신 단계도
  //   그대로 재검증해야 한다. 빠지면 조회~갱신 창에서 쿠폰이 발급돼도 status=WAIT/claimed_at NULL
  //   경로로 취소·환불이 통과할 수 있다(현재는 타 모듈이 claimed_at 을 먼저 채워 간접 차단될 뿐).
  it('갱신 순간에 발급/진행 신호(coupon_issued_at / bar_code / report_state)도 재검사한다', async () => {
    const { sut, calls } = setup();

    await sut.cancelDeliveriesIfStillWaiting(ORDER_ID, [9003], '고객 요청', AT);

    expect(calls).toContain('couponIssuedAt IS NULL');
    expect(calls).toContain('barCode IS NULL');
    expect(calls).toContain('reportState IS NULL');
  });

  it('soft-delete 된 행을 제외한다 (UpdateQueryBuilder 는 자동 적용하지 않는다)', async () => {
    const { sut, calls } = setup();

    await sut.cancelDeliveriesIfStillWaiting(ORDER_ID, [9003], '고객 요청', AT);

    expect(calls).toContain('deletedAt IS NULL');
  });

  it('취소 사유와 시각을 발송건에 남긴다', async () => {
    const { sut, getSetValues } = setup();

    await sut.cancelDeliveriesIfStillWaiting(ORDER_ID, [9003], '고객 요청', AT);

    // ※ mutationClaimedAt 이 추가된 이유는 아래 fencing 테스트 참조 (197-16 리뷰 P1).
    //   여기 단언이 늘어난 것은 계약이 넓어진 것이지 이 테스트의 관심사가 바뀐 게 아니다.
    expect(getSetValues()).toEqual({
      status: IOrderDeliveryStatus.CANCEL,
      cancelReason: '고객 요청',
      canceledAt: AT,
      mutationClaimedAt: AT,
    });
  });

  // ★ 지키는 것은 "토큰을 쓴다" 가 아니라 **좀비를 막는다** 이다.
  //   WHERE 가 stale lease 를 통과시키는 순간(= 남의 소유권을 무시하기로 결정) SET 이 그 토큰을
  //   갱신하지 않으면, 아직 살아 있는 원 소유자의 후속 쓰기가 `WHERE mutation_claimed_at = 자기토큰`
  //   으로 여전히 일치해 성공한다. 그 쓰기는 status 를 다시 쓰므로 방금 CANCEL 한 행이 COMPLETE 로
  //   되살아나고, 환불은 이미 끝난 뒤다. 두 단언을 함께 두어 **전제와 의무를 한 자리에서** 고정한다.
  it('stale 변형 lease 를 통과시켰다면 SET 으로 탈취한다 (좀비 fencing)', async () => {
    const { sut, calls, getSetValues } = setup();

    await sut.cancelDeliveriesIfStillWaiting(ORDER_ID, [9003], '고객 요청', AT);

    // 전제 — stale 을 통과시키는 조건이 실제로 있다. 없다면 탈취 의무도 없다.
    expect(calls.some((c) => c.includes('mutationClaimedAt') && c.includes('mutationStale'))).toBe(true);
    // 의무 — 그렇다면 반드시 토큰을 우리 값으로 덮어써야 한다.
    expect(getSetValues()).toHaveProperty('mutationClaimedAt', AT);
  });

  it('요청 건수만큼 갱신되면 조용히 성공한다', async () => {
    const { sut } = setup({ affected: 3 });

    await expect(sut.cancelDeliveriesIfStillWaiting(ORDER_ID, [9003, 9004, 9005], 'r', AT)).resolves.toBeUndefined();
  });

  // 계약을 반환값이 아니라 제어흐름으로 강제한다. TypeScript 에는 반환값 무시를 막는 수단이
  // 없어(`await fn(...)` 이 경고 없이 통과) "호출자가 반드시 검사하라" 는 주석은 강제력이 없다.
  // @Transactional() 이라 throw 가 곧 롤백이고, 어차피 롤백이 유일한 정답이다.
  it('갱신 건수가 모자라면 던져서 트랜잭션을 되돌린다', async () => {
    const { sut } = setup({ affected: 2 });

    await expect(
      sut.cancelDeliveriesIfStillWaiting(ORDER_ID, [9003, 9004, 9005], 'r', AT),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('실패 메시지가 "아무것도 취소되지 않았다" 를 알린다 — 운영자의 확인 작업을 줄인다', async () => {
    const { sut } = setup({ affected: 1 });

    await expect(sut.cancelDeliveriesIfStillWaiting(ORDER_ID, [9003, 9004], 'r', AT)).rejects.toThrow(
      /환불도 일어나지 않았습니다/,
    );
  });

  it('affected 가 undefined 면 0 으로 보고 던진다', async () => {
    const { sut } = setup({});

    await expect(sut.cancelDeliveriesIfStillWaiting(ORDER_ID, [9003], 'r', AT)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  // SQL 의 IN 은 집합이라 중복을 접는다. 접기 전 길이와 비교하면 정상 취소가 "경합" 으로 오판된다.
  // DTO 의 @ArrayUnique 가 정상 경로를 막지만 서비스 직접 호출 경로 대비로 여기서도 접는다.
  it('중복 id 를 접어서 비교한다 — 가짜 경합을 만들지 않는다', async () => {
    const { sut, params } = setup({ affected: 2 });

    await expect(
      sut.cancelDeliveriesIfStillWaiting(ORDER_ID, [9003, 9003, 9004], 'r', AT),
    ).resolves.toBeUndefined();
    expect(params.deliveryIds).toEqual([9003, 9004]);
  });

  // 조용히 성공으로 처리하면 "요청 0건 = affected 0건" 이 되어 전부 성공으로 판정되고,
  // 발송건은 하나도 취소되지 않은 채 환불만 실행된다.
  it('대상이 비어 있으면 호출자 버그로 보고 던진다 (쿼리도 실행하지 않는다)', async () => {
    const { sut, createQueryBuilder } = setup();

    await expect(sut.cancelDeliveriesIfStillWaiting(ORDER_ID, [], 'r', AT)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(createQueryBuilder).not.toHaveBeenCalled();
  });
});
