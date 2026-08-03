import { resolveDeliveryDestroyAt, resolveOrderEffectiveDestroyAt } from './effective.destroy.date';
import { DESTROYED_AT_SOURCE } from './destroyed.at.source';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';

/**
 * 실효 파기일 계산 규칙 고정.
 *
 * 이 함수는 성격이 다른 두 답을 낸다:
 *  · 이미 파기된 행 → destroyed_at **실적**을 그대로 읽는다(계산 없음).
 *  · 아직 안 지운 행 → 배치 규칙을 날짜로 옮긴 **예정일**을 계산한다.
 *
 * 예정일 계산은 delivery.batch.service.ts 의 정기파기 쿼리를 손으로 복제한 것이라, 두 곳이
 * 어긋나면 고객사에 고지한 파기일과 실제 파기일이 달라진다. 배치 쪽 가드의 3개 절
 * (만료/expireAt NULL/soft-delete)에 각각 대응하는 케이스를 둔다.
 * 쿠폰 상태는 판정에 쓰지 않는다 — 유효기간이 남아 있으면 사용 완료 건도 보류한다.
 *
 * 배치 SQL 자체의 필터 동작은 target-destroy-expiry-guard.db-integration-test.ts 가
 * 실DB 로 검증한다. 여기서는 "그래서 며칠인가"만 다룬다.
 */
describe('resolveDeliveryDestroyAt — 발송건 1건의 파기일', () => {
  const day = (iso: string) => new Date(iso);
  /** {at, kind} 에서 날짜만 뽑는다. null 이면 null. */
  const ymd = (r: { at: Date } | null) => {
    const d = r?.at ?? null;
    return d
      ? `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`
      : null;
  };
  const kindOf = (r: { kind: string } | null) => r?.kind ?? null;

  // 아직 파기되지 않은 발송건 — 수신처가 살아 있고 파기 시각도 없다.
  const alive = {
    deletedAt: null,
    couponStatus: OrderDeliveryCouponStatus.NOT_USED,
    deliveryTarget: '01011112222',
    destroyedAt: null,
    destroyedAtSource: null,
    emailReceiverPhone: null,
  };
  // 이미 파기된 발송건 — PII 가 '-' 로 마스킹되고 파기 시각이 각인된 상태.
  // 출처 BATCH = 실측이므로 kind 는 ACTUAL 이 된다.
  const destroyedAt = (iso: string) => ({
    ...alive,
    deliveryTarget: '-',
    emailReceiverPhone: '-',
    destroyedAt: day(iso),
    destroyedAtSource: 'BATCH' as const,
  });

  describe('예정일 계산 (아직 파기되지 않은 건)', () => {
    it('유효기간이 파기기준일보다 이르면 기준일 그대로다 (가드가 개입하지 않음)', () => {
      // 발송 2026-01-01 + 180일 = 2026-06-30. 유효기간은 2026-03-01 로 그보다 앞선다.
      const at = resolveDeliveryDestroyAt(
        { ...alive, expireAt: day('2026-03-01T10:00:00') },
        day('2026-01-01T14:00:00'),
        180,
      );
      expect(ymd(at)).toBe('2026-06-30');
    });

    it('유효기간이 파기기준일보다 뒤면 만료 다음 날로 미뤄진다 (이 기능의 핵심)', () => {
      // 유효기간 5년 상품 / 파기 180일 — 기준일은 2026-06-30 이지만 실제 파기는 2031 년이다.
      const at = resolveDeliveryDestroyAt(
        { ...alive, expireAt: day('2030-12-31T23:59:00') },
        day('2026-01-01T14:00:00'),
        180,
      );
      expect(ymd(at)).toBe('2031-01-01'); // 만료 당일은 아직 유효 → 다음 날
    });

    it('시분초는 버리고 날짜 단위로 계산한다 (배치의 DATE() 절삭과 동일)', () => {
      const early = resolveDeliveryDestroyAt(
        { ...alive, expireAt: day('2030-12-31T00:30:00') },
        day('2026-01-01T00:00:01'),
        180,
      );
      const late = resolveDeliveryDestroyAt(
        { ...alive, expireAt: day('2030-12-31T23:59:59') },
        day('2026-01-01T23:59:59'),
        180,
      );
      expect(ymd(early)).toBe('2031-01-01');
      expect(ymd(late)).toBe('2031-01-01'); // 같은 날짜면 시각과 무관하게 같은 답
    });

    it('유효기간이 없으면(expireAt NULL) 기준일 그대로다 — 배치 가드 1번 절', () => {
      const at = resolveDeliveryDestroyAt({ ...alive, expireAt: null }, day('2026-01-01T14:00:00'), 180);
      expect(ymd(at)).toBe('2026-06-30');
    });

    it('soft-delete 된 건은 유효기간이 남아도 기준일 그대로다 — 배치 가드 3번 절', () => {
      const at = resolveDeliveryDestroyAt(
        { ...alive, expireAt: day('2030-12-31T00:00:00'), deletedAt: day('2026-02-01T00:00:00') },
        day('2026-01-01T14:00:00'),
        180,
      );
      expect(ymd(at)).toBe('2026-06-30');
    });

    it.each([
      OrderDeliveryCouponStatus.USED,
      OrderDeliveryCouponStatus.CANCEL,
      OrderDeliveryCouponStatus.REFUND_CANCEL,
      OrderDeliveryCouponStatus.EXPIRED,
    ])('쿠폰 상태(%s)는 판정에 쓰지 않는다 — 유효기간이 남아 있으면 상태 불문 미뤄진다', (couponStatus) => {
      // 운영 결정: 판정 기준은 유효기간 하나다. 사용 완료된 쿠폰도 유효기간 동안은 파기하지 않는다.
      // couponStatus 를 넘겨도 결과가 달라지지 않음을 고정한다(시그니처가 이 필드를 받지 않는다).
      const at = resolveDeliveryDestroyAt(
        { ...alive, expireAt: day('2030-12-31T00:00:00'), couponStatus } as never,
        day('2026-01-01T14:00:00'),
        180,
      );
      expect(ymd(at)).toBe('2031-01-01');
    });

    it('파기일수가 NULL 이면 null — 배치가 이 행을 영원히 집지 않으므로 날짜를 지어내지 않는다', () => {
      // INTERVAL NULL DAY → NULL 이라 주 날짜 절이 성립하지 않는다(기존 결함, 이 기능의 소관 아님).
      expect(resolveDeliveryDestroyAt({ ...alive, expireAt: null }, day('2026-01-01T00:00:00'), null)).toBeNull();
    });

    it('발송요청일이 없으면 null', () => {
      expect(resolveDeliveryDestroyAt({ ...alive, expireAt: null }, null, 180)).toBeNull();
    });
  });

  describe('실적 우선 (destroyed_at)', () => {
    it('파기 시각이 기록된 건은 예정일이 아니라 실제로 지운 날을 돌려준다', () => {
      // 유효기간 5년 상품을 발송 한 달 만에 조기파기한 경우.
      // 실적을 무시하면 파기확인서에 2031-01-01(4년 11개월 뒤)이 인쇄된다.
      const at = resolveDeliveryDestroyAt(
        { ...destroyedAt('2026-02-01T09:30:00'), expireAt: day('2030-12-31T00:00:00') },
        day('2026-01-01T14:00:00'),
        180,
      );
      expect(ymd(at)).toBe('2026-02-01');
    });

    it('★ 옛 규칙으로 파기된 레거시 행에 새 규칙을 소급하지 않는다 (재리뷰 H-1)', () => {
      // 유효기간 가드 이전에 정기파기된 행. 옛 배치는 유효기간을 보지 않았으므로
      // 발송요청일+180 = 2026-06-30 에 지웠고, 그 시각이 destroyed_at 에 백필돼 있다.
      // 계산으로 답하면 MAX(2026-06-30, 2031-01-02) = 2031-01-02 — 이미 지운 건에 미래 날짜다.
      const at = resolveDeliveryDestroyAt(
        { ...destroyedAt('2026-06-30T00:00:03'), expireAt: day('2031-01-01T00:00:00') },
        day('2026-01-01T14:00:00'),
        180,
      );
      expect(ymd(at)).toBe('2026-06-30');
    });

    it('파기됐는데 시각 기록이 없으면 null — 예정일로 폴백하면 H-1 이 재현된다', () => {
      // 백필에서 기준 컬럼 결측으로 못 채웠거나, 백필 전에 코드가 배포된 경우.
      // "지운 것은 맞는데 언제인지 모른다"를 날짜로 위장하지 않는다.
      const at = resolveDeliveryDestroyAt(
        { ...alive, deliveryTarget: '-', emailReceiverPhone: '-', expireAt: day('2031-01-01T00:00:00') },
        day('2026-01-01T14:00:00'),
        180,
      );
      expect(at).toBeNull();
    });

    it('실적일은 시분초를 버린 날짜로 절삭된다', () => {
      const at = resolveDeliveryDestroyAt(
        { ...destroyedAt('2026-02-01T23:59:59'), expireAt: null },
        day('2026-01-01'),
        180,
      );
      expect(ymd(at)).toBe('2026-02-01');
      // ⚠️ ymd 는 시간 성분을 버리므로 위 단언만으로는 절삭을 검증하지 못한다(atStartOfDay 를
      //    지우고 인자를 그대로 반환해도 통과한다). 시각을 직접 봐야 실제로 고정된다.
      expect(at?.at.getHours()).toBe(0);
      expect(at?.at.getMinutes()).toBe(0);
      expect(at?.at.getSeconds()).toBe(0);
      expect(at?.at.getMilliseconds()).toBe(0);
    });

    it('실적일이 예정일보다 뒤여도 실적이 이긴다 — 예정일은 추정, 실적은 사실이다', () => {
      // 파기가 지연 실행된 경우. MAX 를 취하지 않는다(그러면 다시 추정값이 섞인다).
      const at = resolveDeliveryDestroyAt(
        { ...destroyedAt('2026-08-15T10:00:00'), expireAt: day('2026-03-01T00:00:00') },
        day('2026-01-01T14:00:00'),
        180, // 예정 2026-06-30
      );
      expect(ymd(at)).toBe('2026-08-15');
    });

    it('실적일이 있으면 파기일수/발송요청일이 없어도 null 이 아니다 — 이미 지운 사실은 확정이다', () => {
      const at = resolveDeliveryDestroyAt({ ...destroyedAt('2026-02-01T00:00:00'), expireAt: null }, null, null);
      expect(ymd(at)).toBe('2026-02-01');
    });

    it('파기 시각이 없고 아직 안 지워진 건은 종전대로 예정일을 계산한다', () => {
      const at = resolveDeliveryDestroyAt({ ...alive, expireAt: null }, day('2026-01-01T14:00:00'), 180);
      expect(ymd(at)).toBe('2026-06-30');
    });

    it('출처가 백필 추정이면 kind 가 ACTUAL_ESTIMATED 다 — 날짜만으로는 구분할 수 없다', () => {
      // 대외 증빙에 "이 날짜가 실제 기록입니까"에 답하려면 성격을 함께 들고 다녀야 한다.
      const est = resolveDeliveryDestroyAt(
        { ...destroyedAt('2026-06-30T00:00:00'), destroyedAtSource: 'BACKFILL_ESTIMATE', expireAt: null },
        day('2026-01-01T14:00:00'),
        180,
      );
      expect(kindOf(est)).toBe('ACTUAL_ESTIMATED');
      expect(ymd(est)).toBe('2026-06-30'); // 날짜는 같다 — 그래서 kind 가 필요하다
    });

    it.each(['EARLY', 'BATCH', 'BACKFILL_EARLY'])('출처가 실측(%s)이면 kind 는 ACTUAL 이다', (source) => {
      const at = resolveDeliveryDestroyAt(
        { ...destroyedAt('2026-02-01T09:30:00'), destroyedAtSource: source as never, expireAt: null },
        day('2026-01-01T14:00:00'),
        180,
      );
      expect(kindOf(at)).toBe('ACTUAL');
    });

    it('출처가 NULL 이면 추정으로 취급한다 (fail-closed) — 모르는 것을 사실로 승격시키지 않는다', () => {
      const at = resolveDeliveryDestroyAt(
        { ...destroyedAt('2026-02-01T09:30:00'), destroyedAtSource: null, expireAt: null },
        day('2026-01-01T14:00:00'),
        180,
      );
      expect(kindOf(at)).toBe('ACTUAL_ESTIMATED');
    });

    it('아직 파기되지 않은 건의 kind 는 SCHEDULED 다', () => {
      const at = resolveDeliveryDestroyAt({ ...alive, expireAt: null }, day('2026-01-01T14:00:00'), 180);
      expect(kindOf(at)).toBe('SCHEDULED');
    });

    it('★ 이메일 수신번호만 되살아난 행도 부활로 본다 — deliveryTarget 은 여전히 마스킹 상태다 (리뷰 HIGH-1)', () => {
      // CS 수신정보 변경은 '이메일+핀발급' 건에서 emailReceiverPhone 만 갱신하고 deliveryTarget 은
      // 건드리지 않는다. deliveryTarget 만 보면 이 행이 "파기됨"으로 판정되어, 살아있는 전화번호
      // 옆에 과거 실적일이 인쇄된다 — 판정 순서를 뒤집어 막으려던 모순의 다른 얼굴이다.
      const at = resolveDeliveryDestroyAt(
        {
          ...destroyedAt('2026-01-31T00:00:00'),
          emailReceiverPhone: '01099998888', // 되살아난 PII
          expireAt: day('2030-12-31T00:00:00'),
        },
        day('2026-01-01T14:00:00'),
        180,
      );
      expect(ymd(at)).toBe('2031-01-01'); // 과거 실적(2026-01-31)이 아니라 예정일
      expect(kindOf(at)).toBe('SCHEDULED');
    });

    it('★ 파기 기록은 있는데 수신처가 살아있으면 실적이 아니라 예정일을 답한다 (CS 수신정보 변경)', () => {
      // 파기 후 CS 사후 대응을 위해 수신처를 다시 채워 넣는 경로가 의도적으로 열려 있다
      // (customer.service.service.ts 의 RECEIVER_CHANGE). 그러면 "언제 지웠나"(destroyedAt)와
      // "지금 지워져 있나"(deliveryTarget)가 갈린다.
      // destroyedAt 을 먼저 보면 살아있는 수신처 옆에 과거 파기일이 인쇄된다 — 한 장의 문서에
      // 모순이 찍힌다. 그 행은 다음 배치 회차에 다시 파기되므로 예정일이 정답이다.
      const at = resolveDeliveryDestroyAt(
        { ...alive, destroyedAt: day('2026-01-31T00:00:00'), expireAt: day('2030-12-31T00:00:00') },
        day('2026-01-01T14:00:00'),
        180,
      );
      expect(ymd(at)).toBe('2031-01-01'); // 과거 실적(2026-01-31)이 아니라 예정일
    });
  });
});

describe('resolveOrderEffectiveDestroyAt — 주문 단위 집계', () => {
  /** {at, kind} 에서 날짜만 뽑는다. null 이면 null. */
  const ymd = (r: { at: Date } | null) => {
    const d = r?.at ?? null;
    return d
      ? `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`
      : null;
  };
  const kindOf = (r: { kind: string } | null) => r?.kind ?? null;
  const mapping = (deliveries: any[], destroyDay: number | null = 180) => ({
    sendRequestAt: new Date('2026-01-01T14:00:00'),
    requestToDestroyPersonalInfoDay: destroyDay,
    orderDeliveries: deliveries,
  });
  const aliveDelivery = (expireAt: Date | null) => ({
    expireAt,
    deletedAt: null,
    couponStatus: OrderDeliveryCouponStatus.NOT_USED,
    deliveryTarget: '01011112222',
    destroyedAt: null,
  });
  /**
   * 이미 파기된 발송건 — PII 마스킹과 파기 시각이 함께 있다.
   *
   * ⚠️ source 를 **반드시** 넘겨야 한다. 생략하면 undefined → isEstimatedDestroyedAt 이
   *    fail-closed 로 '추정'을 돌려주므로 kind 가 ACTUAL_ESTIMATED 가 된다. 예전에는 기본값이
   *    없어서 `// ACTUAL` 이라 주석 단 픽스처가 실제로는 추정이었고, 그 결과 "실적 + 추정 →
   *    추정" 테스트가 **양쪽 다 추정**이라 공허하게 통과했다(리뷰 3차 M-3). 기본값을 BATCH(실측)
   *    로 두어 그 사고를 막는다 — 추정을 원하면 명시적으로 넘긴다.
   */
  const destroyedDelivery = (
    expireAt: Date | null,
    destroyedAtIso: string,
    destroyedAtSource: string = DESTROYED_AT_SOURCE.BATCH,
  ) => ({
    ...aliveDelivery(expireAt),
    deliveryTarget: '-',
    destroyedAt: new Date(destroyedAtIso),
    destroyedAtSource,
  });

  it('발송건마다 파기일이 다르면 가장 늦은 날을 쓴다 — "이 날이면 전부 지워져 있다"를 보장', () => {
    const order: any = {
      orderProductMappings: [
        mapping([aliveDelivery(new Date('2026-03-01T00:00:00'))]), // 기준일 2026-06-30
        mapping([aliveDelivery(new Date('2030-12-31T00:00:00'))]), // 2031-01-01
      ],
    };
    expect(ymd(resolveOrderEffectiveDestroyAt(order))).toBe('2031-01-01');
  });

  it('파기일을 특정할 수 없는 발송건이 하나라도 있으면 주문 전체가 null', () => {
    // 일부만 보고 "전부 파기됨"이라 고지할 수 없다.
    const order: any = {
      orderProductMappings: [
        mapping([aliveDelivery(new Date('2026-03-01T00:00:00'))]),
        mapping([aliveDelivery(null)], null), // 파기일수 NULL
      ],
    };
    expect(resolveOrderEffectiveDestroyAt(order)).toBeNull();
  });

  it('파기됐는데 시각 기록이 없는 건이 섞이면 주문 전체가 null', () => {
    // 한 건이라도 근거가 없으면 주문 단위 진술도 성립하지 않는다.
    const unknown = { ...aliveDelivery(new Date('2030-12-31T00:00:00')), deliveryTarget: '-', emailReceiverPhone: '-' };
    const order: any = { orderProductMappings: [mapping([aliveDelivery(null), unknown])] };
    expect(resolveOrderEffectiveDestroyAt(order)).toBeNull();
  });

  it('폐기후재발행 tip 이 포함된 집합을 넘기면 tip 의 늦은 유효기간이 MAX 에 반영된다', () => {
    // 호출부 계약 고정 — 이 함수는 hideDiscardReissueDeliveries **이전** 집합을 받아야 한다.
    // 배치에는 replacedFromId 필터가 없어 tip 도 파기 대상이므로, tip 을 뺀 집합으로 계산하면
    // 실제보다 이른 날짜를 고지하게 된다(원본 2031-01-01 인데 tip 이 2031-06-02 까지 남는 식).
    const original = aliveDelivery(new Date('2030-12-31T00:00:00')); // → 2031-01-01
    const reissueTip = { ...aliveDelivery(new Date('2031-06-01T00:00:00')), replacedFromId: 1 }; // → 2031-06-02

    const withTip: any = { orderProductMappings: [mapping([original, reissueTip])] };
    const withoutTip: any = { orderProductMappings: [mapping([original])] };

    expect(ymd(resolveOrderEffectiveDestroyAt(withTip))).toBe('2031-06-02');
    // tip 을 걸러낸 집합을 넘기면 5개월 이른 날짜가 나온다 — 이 차이가 고지 오류의 크기다.
    expect(ymd(resolveOrderEffectiveDestroyAt(withoutTip))).toBe('2031-01-01');
  });

  it('일부만 파기된 주문 — 실적일과 예정일이 섞여도 MAX 의미가 유지된다', () => {
    // 발송건 2개 중 하나만 이미 파기. 이미 지운 건의 실적일은 과거라 MAX 에 영향을 주지 않고,
    // 남은 건의 예정일이 "이 날이면 전부 지워져 있다"를 결정한다.
    const done = { ...destroyedDelivery(new Date('2030-12-31T00:00:00'), '2026-02-01T09:00:00'), id: 1 };
    const pending = { ...aliveDelivery(new Date('2026-03-01T00:00:00')), id: 2 }; // 예정 2026-06-30

    const order: any = { orderProductMappings: [mapping([done, pending])] };

    expect(ymd(resolveOrderEffectiveDestroyAt(order))).toBe('2026-06-30');
  });

  it('발송건이 전부 파기된 주문에서는 MAX 가 곧 실적일이다', () => {
    // "실적일은 과거라 MAX 에 영향을 주지 않는다"고 단정하면 안 되는 반례.
    const d1 = destroyedDelivery(new Date('2030-12-31T00:00:00'), '2026-02-01T09:00:00');
    const d2 = destroyedDelivery(new Date('2030-12-31T00:00:00'), '2026-03-15T09:00:00');
    const order: any = { orderProductMappings: [mapping([d1, d2])] };
    expect(ymd(resolveOrderEffectiveDestroyAt(order))).toBe('2026-03-15');
  });

  it('★ 주문 kind 는 가장 약한 것을 택한다 — 실적 + 예정이면 SCHEDULED', () => {
    // "이 날이면 전부 지워져 있다"는 진술은 가장 불확실한 구성요소만큼만 강하다.
    const done = destroyedDelivery(new Date('2030-12-31T00:00:00'), '2026-02-01T09:00:00'); // ACTUAL (기본 출처 BATCH)
    const pending = aliveDelivery(new Date('2026-03-01T00:00:00')); // SCHEDULED
    const order: any = { orderProductMappings: [mapping([done, pending])] };
    expect(resolveOrderEffectiveDestroyAt(order)?.kind).toBe('SCHEDULED');
  });

  // ↓ 양성 대조군. 아래 '추정이 섞이면 강등' 테스트가 **공허하게** 통과하지 않는다는 증거다
  //   (둘 다 추정인 픽스처면 강등 없이도 통과한다 — 실제로 그런 상태였다, 리뷰 3차 M-3).
  it('★ 전 발송건이 실측이면 주문 전체가 ACTUAL 이다 (강등 테스트의 양성 대조군)', () => {
    const a = destroyedDelivery(new Date('2030-12-31T00:00:00'), '2026-02-01T09:00:00', DESTROYED_AT_SOURCE.EARLY);
    const b = destroyedDelivery(new Date('2030-12-31T00:00:00'), '2026-06-30T00:00:00', DESTROYED_AT_SOURCE.BATCH);
    const order: any = { orderProductMappings: [mapping([a, b])] };
    expect(resolveOrderEffectiveDestroyAt(order)?.kind).toBe('ACTUAL');
  });

  it('★ 실적만 있어도 하나가 추정이면 주문 전체가 ACTUAL_ESTIMATED', () => {
    // 위 대조군과 다른 점은 두 번째 건의 **출처 하나뿐**이다.
    const actual = destroyedDelivery(new Date('2030-12-31T00:00:00'), '2026-02-01T09:00:00', DESTROYED_AT_SOURCE.EARLY);
    const estimated = destroyedDelivery(
      new Date('2030-12-31T00:00:00'),
      '2026-06-30T00:00:00',
      DESTROYED_AT_SOURCE.BACKFILL_ESTIMATE,
    );
    const order: any = { orderProductMappings: [mapping([actual, estimated])] };
    expect(resolveOrderEffectiveDestroyAt(order)?.kind).toBe('ACTUAL_ESTIMATED');
  });

  it('발송건이 없으면 null (증명할 내용이 없다)', () => {
    expect(resolveOrderEffectiveDestroyAt({ orderProductMappings: [mapping([])] } as any)).toBeNull();
    expect(resolveOrderEffectiveDestroyAt({ orderProductMappings: [] } as any)).toBeNull();
  });
});
