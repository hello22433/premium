import {
  allocateSsgEventsForDeliveries,
  AllocatableEvent,
  AllocatableDelivery,
  SsgAllocationIndeterminateError,
} from './ssg.event.allocation';

const at = (s: string) => new Date(s);

/** 주어진 할당 결과가 잔액/유효기간 제약을 실제로 만족하는지 검증하는 헬퍼 */
const assertFeasible = (
  events: AllocatableEvent[],
  deliveries: AllocatableDelivery[],
  result: ReturnType<typeof allocateSsgEventsForDeliveries>,
  defaultReserveDate?: Date,
) => {
  expect(result).not.toBeNull();
  const byId = new Map(events.map((e) => [e.id, e]));
  const spent = new Map<number, number>();
  const deliveryById = new Map(deliveries.map((d) => [d.deliveryId, d]));

  for (const alloc of result!) {
    const event = byId.get(alloc.eventId)!;
    const delivery = deliveryById.get(alloc.deliveryId)!;
    // 배송건 예약시각에 행사가 유효해야 한다
    const ref = (delivery.reserveDate ?? defaultReserveDate ?? new Date()).getTime();
    expect(event.startAt.getTime()).toBeLessThanOrEqual(ref);
    expect(event.endAt.getTime()).toBeGreaterThanOrEqual(ref);
    spent.set(alloc.eventId, (spent.get(alloc.eventId) ?? 0) + alloc.price);
  }
  // 행사별 배정 합계가 잔액을 초과하면 안 된다
  for (const [eventId, total] of spent) {
    expect(total).toBeLessThanOrEqual(byId.get(eventId)!.eventBalance);
  }
};

describe('allocateSsgEventsForDeliveries', () => {
  it('행사가 없으면 null', () => {
    expect(allocateSsgEventsForDeliveries([], [{ deliveryId: 1, price: 100 }])).toBeNull();
  });

  it('배송건 예약시각에 유효한 행사가 없으면 null', () => {
    const events: AllocatableEvent[] = [
      { id: 1, startAt: at('2026-07-01T00:00:00'), endAt: at('2026-07-02T23:59:59'), eventBalance: 1000 },
    ];
    const deliveries: AllocatableDelivery[] = [{ deliveryId: 1, price: 100, reserveDate: at('2026-07-10T10:00:00') }];
    expect(allocateSsgEventsForDeliveries(events, deliveries)).toBeNull();
  });

  it('배송건마다 예약시각이 다르면 각자 유효한 행사에 매칭한다', () => {
    const events: AllocatableEvent[] = [
      { id: 1, startAt: at('2026-07-01T00:00:00'), endAt: at('2026-07-02T23:59:59'), eventBalance: 10000 },
      { id: 2, startAt: at('2026-07-03T00:00:00'), endAt: at('2026-07-04T23:59:59'), eventBalance: 10000 },
    ];
    const deliveries: AllocatableDelivery[] = [
      { deliveryId: 100, price: 5000, reserveDate: at('2026-07-02T14:20:00') },
      { deliveryId: 200, price: 10000, reserveDate: at('2026-07-03T14:20:00') },
    ];
    const result = allocateSsgEventsForDeliveries(events, deliveries);
    assertFeasible(events, deliveries, result);
    expect(result!.find((a) => a.deliveryId === 100)!.eventId).toBe(1);
    expect(result!.find((a) => a.deliveryId === 200)!.eventId).toBe(2);
  });

  // 리뷰 반례: first-fit이면 실패하지만 실제로는 실행 가능한 조합
  it('후보 집합이 다를 때 first-fit이 놓치는 조합도 정확히 찾는다', () => {
    const timeA = at('2026-07-02T10:00:00'); // event1, event2 모두 유효
    const timeB = at('2026-07-03T10:00:00'); // event1만 유효
    const events: AllocatableEvent[] = [
      // id=1: A/B 모두 유효, 잔액 100
      { id: 1, startAt: at('2026-07-01T00:00:00'), endAt: at('2026-07-04T23:59:59'), eventBalance: 100 },
      // id=2: A에만 유효, 잔액 100
      { id: 2, startAt: at('2026-07-02T00:00:00'), endAt: at('2026-07-02T23:59:59'), eventBalance: 100 },
    ];
    const deliveries: AllocatableDelivery[] = [
      { deliveryId: 100, price: 100, reserveDate: timeA }, // first-fit이면 event1 선점
      { deliveryId: 200, price: 100, reserveDate: timeB }, // 그러면 event1 소진 → 실패
    ];

    const result = allocateSsgEventsForDeliveries(events, deliveries);
    assertFeasible(events, deliveries, result);
    // 유일한 정상 조합: B(200)는 event1만 가능 → A(100)는 event2
    expect(result!.find((a) => a.deliveryId === 200)!.eventId).toBe(1);
    expect(result!.find((a) => a.deliveryId === 100)!.eventId).toBe(2);
  });

  it('실제로 잔액이 부족하면 null', () => {
    const events: AllocatableEvent[] = [
      { id: 1, startAt: at('2026-07-01T00:00:00'), endAt: at('2026-07-31T23:59:59'), eventBalance: 100 },
    ];
    const deliveries: AllocatableDelivery[] = [
      { deliveryId: 1, price: 100, reserveDate: at('2026-07-10T10:00:00') },
      { deliveryId: 2, price: 100, reserveDate: at('2026-07-10T10:00:00') },
    ];
    expect(allocateSsgEventsForDeliveries(events, deliveries)).toBeNull();
  });

  it('reserveDate가 없으면 defaultReserveDate 기준으로 매칭한다', () => {
    const events: AllocatableEvent[] = [
      { id: 1, startAt: at('2026-07-01T00:00:00'), endAt: at('2026-07-31T23:59:59'), eventBalance: 10000 },
    ];
    const deliveries: AllocatableDelivery[] = [{ deliveryId: 1, price: 5000 }];
    const result = allocateSsgEventsForDeliveries(events, deliveries, at('2026-07-15T10:00:00'));
    assertFeasible(events, deliveries, result, at('2026-07-15T10:00:00'));
    expect(result!.find((a) => a.deliveryId === 1)!.eventId).toBe(1);
  });

  it('잔액이 넉넉하면 먼저 등록한 행사(작은 id)를 우선 사용한다', () => {
    const events: AllocatableEvent[] = [
      { id: 1, startAt: at('2026-07-01T00:00:00'), endAt: at('2026-07-31T23:59:59'), eventBalance: 100000 },
      { id: 2, startAt: at('2026-07-01T00:00:00'), endAt: at('2026-07-31T23:59:59'), eventBalance: 100000 },
    ];
    const deliveries: AllocatableDelivery[] = [
      { deliveryId: 1, price: 5000, reserveDate: at('2026-07-10T10:00:00') },
      { deliveryId: 2, price: 5000, reserveDate: at('2026-07-10T10:00:00') },
    ];
    const result = allocateSsgEventsForDeliveries(events, deliveries);
    expect(result!.every((a) => a.eventId === 1)).toBe(true);
  });

  it('결과는 입력 배송건 순서를 유지한다', () => {
    const events: AllocatableEvent[] = [
      { id: 1, startAt: at('2026-07-01T00:00:00'), endAt: at('2026-07-31T23:59:59'), eventBalance: 100000 },
    ];
    const deliveries: AllocatableDelivery[] = [
      { deliveryId: 30, price: 1000, reserveDate: at('2026-07-10T10:00:00') },
      { deliveryId: 10, price: 1000, reserveDate: at('2026-07-10T10:00:00') },
      { deliveryId: 20, price: 1000, reserveDate: at('2026-07-10T10:00:00') },
    ];
    const result = allocateSsgEventsForDeliveries(events, deliveries);
    expect(result!.map((a) => a.deliveryId)).toEqual([30, 10, 20]);
  });
  it('전역 수요가 후보 잔액 합을 초과하면 대량 조합도 즉시 null로 판정한다 (탐색 폭발 방지)', () => {
    // 행사 8개 × 잔액 100(합 800), 배송 41개 × 가격 20(합 820) → 전역 초과 → 확정 불가
    const events: AllocatableEvent[] = Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      startAt: at('2026-07-01T00:00:00'),
      endAt: at('2026-07-31T23:59:59'),
      eventBalance: 100,
    }));
    const deliveries: AllocatableDelivery[] = Array.from({ length: 41 }, (_, i) => ({
      deliveryId: i + 1,
      price: 20,
      reserveDate: at('2026-07-10T10:00:00'),
    }));

    const start = Date.now();
    const result = allocateSsgEventsForDeliveries(events, deliveries);
    expect(result).toBeNull();
    // 사전검사로 즉시 판정되어야 함 (탐색 폭발 없이)
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('동일 클래스(같은 창)의 여러 행사에 걸친 빠듯한 조합도 대칭 제거로 정확히 할당한다', () => {
    // 같은 창의 행사 3개 × 잔액 100(합 300), 배송 3개 × 100(합 300) → 정확히 소진 가능
    const events: AllocatableEvent[] = Array.from({ length: 3 }, (_, i) => ({
      id: i + 1,
      startAt: at('2026-07-01T00:00:00'),
      endAt: at('2026-07-31T23:59:59'),
      eventBalance: 100,
    }));
    const deliveries: AllocatableDelivery[] = Array.from({ length: 3 }, (_, i) => ({
      deliveryId: 100 + i,
      price: 100,
      reserveDate: at('2026-07-10T10:00:00'),
    }));

    const result = allocateSsgEventsForDeliveries(events, deliveries);
    assertFeasible(events, deliveries, result);
    // 각 행사가 정확히 한 건씩 (100씩) 소비
    const used = new Set(result!.map((a) => a.eventId));
    expect(used.size).toBe(3);
  });

  it('SsgAllocationIndeterminateError는 export되어 잔액부족(null)과 구분 가능하다', () => {
    expect(new SsgAllocationIndeterminateError()).toBeInstanceOf(Error);
  });

  it('배송건이 없으면 빈 배열', () => {
    expect(allocateSsgEventsForDeliveries([], [])).toEqual([]);
  });
  it('배송건이 12,000건이어도 재귀 스택 초과 없이 정확히 할당한다 (반복 탐색 회귀)', () => {
    // event1: A/B 유효(잔액 6000), event2: A만 유효(잔액 6000)
    // 배송: A 6000건 후 B 6000건, 각 가격 1 → 정상해 A→event2, B→event1
    const events: AllocatableEvent[] = [
      { id: 1, startAt: at('2026-07-01T00:00:00'), endAt: at('2026-07-04T23:59:59'), eventBalance: 6000 },
      { id: 2, startAt: at('2026-07-02T00:00:00'), endAt: at('2026-07-02T23:59:59'), eventBalance: 6000 },
    ];
    const timeA = at('2026-07-02T10:00:00'); // event1, event2 모두 유효
    const timeB = at('2026-07-03T10:00:00'); // event1만 유효
    const deliveries: AllocatableDelivery[] = [];
    for (let i = 0; i < 6000; i++) {
      deliveries.push({ deliveryId: i + 1, price: 1, reserveDate: timeA });
    }
    for (let i = 0; i < 6000; i++) {
      deliveries.push({ deliveryId: 6000 + i + 1, price: 1, reserveDate: timeB });
    }

    const result = allocateSsgEventsForDeliveries(events, deliveries);
    assertFeasible(events, deliveries, result);
    // B(6001~12000)는 event1만 가능 → 모두 event1, A(1~6000)는 event2
    for (const alloc of result!) {
      if (alloc.deliveryId > 6000) {
        expect(alloc.eventId).toBe(1);
      } else {
        expect(alloc.eventId).toBe(2);
      }
    }
  });
});
