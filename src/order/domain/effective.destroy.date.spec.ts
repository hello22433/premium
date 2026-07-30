import { resolveDeliveryDestroyAt, resolveOrderEffectiveDestroyAt } from './effective.destroy.date';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';

/**
 * 실효 파기예정일 계산 규칙 고정.
 *
 * 이 규칙은 delivery.batch.service.ts 의 정기파기 쿼리를 손으로 복제한 것이라,
 * 두 곳이 어긋나면 고객사에 고지한 파기일과 실제 파기일이 달라진다. 배치 쪽 가드의
 * 3개 절(만료/expireAt NULL/soft-delete)에 각각 대응하는 케이스를 둔다.
 * 쿠폰 상태는 판정에 쓰지 않는다 — 유효기간이 남아 있으면 사용 완료 건도 보류한다.
 *
 * 배치 SQL 자체의 필터 동작은 target-destroy-expiry-guard.db-integration-test.ts 가
 * 실DB 로 검증한다. 여기서는 "그래서 며칠인가"만 다룬다.
 */
describe('resolveDeliveryDestroyAt — 발송건 1건의 파기예정일', () => {
  const day = (iso: string) => new Date(iso);
  const ymd = (d: Date | null) =>
    d ? `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}` : null;

  // 아직 파기되지 않은 발송건 — 수신처가 살아 있다.
  const alive = {
    deletedAt: null,
    couponStatus: OrderDeliveryCouponStatus.NOT_USED,
    deliveryTarget: '01011112222',
  };
  // 이미 파기된 발송건 — PII 가 '-' 로 마스킹된 상태.
  const destroyed = { ...alive, deliveryTarget: '-' };

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

  it('soft-delete 된 건은 유효기간이 남아도 기준일 그대로다 — 배치 가드 2번 절', () => {
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
      { expireAt: day('2030-12-31T00:00:00'), deletedAt: null, couponStatus } as never,
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

  describe('조기파기 실적일 우선 (리뷰 HIGH-1)', () => {
    it('조기파기된 건은 예정일이 아니라 실제로 지운 날을 돌려준다', () => {
      // 유효기간 5년 상품을 발송 한 달 만에 조기파기한 경우.
      // 실적을 무시하면 파기확인서에 2031-01-01(4년 11개월 뒤)이 인쇄된다.
      const at = resolveDeliveryDestroyAt(
        { ...destroyed, expireAt: day('2030-12-31T00:00:00') },
        day('2026-01-01T14:00:00'),
        180,
        day('2026-02-01T09:30:00'), // 조기파기 실행 시각
      );
      expect(ymd(at)).toBe('2026-02-01');
    });

    it('실적 기록이 있어도 그 행이 아직 안 지워졌으면 실적을 인정하지 않는다 (리뷰 CRITICAL)', () => {
      // 매핑 전체 조기파기 뒤 CS 폐기후재발행이 같은 매핑에 새 행을 만들면, 그 신규 행까지
      // "그때 파기됨"으로 도장이 찍힌다(맵은 매핑 단위로 펼쳐지므로). 그 행은 실제 수신처를
      // 보유하고 있으므로, 실적을 그대로 인정하면 살아있는 PII 에 과거 파기일이 인쇄된다.
      // 행 자신의 상태(deliveryTarget)를 함께 봐야 이 역추론의 틈이 닫힌다.
      const at = resolveDeliveryDestroyAt(
        { ...alive, expireAt: day('2030-12-31T00:00:00') }, // deliveryTarget 이 실제 번호
        day('2026-01-01T14:00:00'),
        180,
        day('2026-02-01T09:30:00'), // 맵에는 실적이 있지만
      );
      expect(ymd(at)).toBe('2031-01-01'); // 실적 무시하고 예정일로 답한다
    });

    it('실적일은 시분초를 버린 날짜로 절삭된다', () => {
      const at = resolveDeliveryDestroyAt(
        { ...destroyed, expireAt: null },
        day('2026-01-01'),
        180,
        day('2026-02-01T23:59:59'),
      );
      expect(ymd(at)).toBe('2026-02-01');
      // ⚠️ ymd 는 시간 성분을 버리므로 위 단언만으로는 절삭을 검증하지 못한다(atStartOfDay 를
      //    지우고 인자를 그대로 반환해도 통과한다). 시각을 직접 봐야 실제로 고정된다.
      expect(at?.getHours()).toBe(0);
      expect(at?.getMinutes()).toBe(0);
      expect(at?.getSeconds()).toBe(0);
      expect(at?.getMilliseconds()).toBe(0);
    });

    it('실적일이 예정일보다 뒤여도 실적이 이긴다 — 예정일은 추정, 실적은 사실이다', () => {
      // 파기가 지연 실행된 경우. MAX 를 취하지 않는다(그러면 다시 추정값이 섞인다).
      const at = resolveDeliveryDestroyAt(
        { ...destroyed, expireAt: day('2026-03-01T00:00:00') },
        day('2026-01-01T14:00:00'),
        180, // 예정 2026-06-30
        day('2026-08-15T10:00:00'),
      );
      expect(ymd(at)).toBe('2026-08-15');
    });

    it('실적일이 없으면(정기파기 또는 미파기) 종전대로 예정일을 계산한다', () => {
      // 정기파기는 실적 기록이 없어 계산값으로 답한다(배치가 정상 동작할 때의 추정치).
      const undef = resolveDeliveryDestroyAt({ ...alive, expireAt: null }, day('2026-01-01T14:00:00'), 180, undefined);
      const nul = resolveDeliveryDestroyAt({ ...alive, expireAt: null }, day('2026-01-01T14:00:00'), 180, null);
      expect(ymd(undef)).toBe('2026-06-30');
      expect(ymd(nul)).toBe('2026-06-30');
    });

    it('실적일이 있으면 파기일수/발송요청일이 없어도 null 이 아니다 — 이미 지운 사실은 확정이다', () => {
      const at = resolveDeliveryDestroyAt({ ...destroyed, expireAt: null }, null, null, day('2026-02-01T00:00:00'));
      expect(ymd(at)).toBe('2026-02-01');
    });
  });
});

describe('resolveOrderEffectiveDestroyAt — 주문 단위 집계', () => {
  const ymd = (d: Date | null) =>
    d ? `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}` : null;
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
  });
  /** 이미 파기된 발송건 — 실적일을 인정받으려면 행 자신도 '-' 여야 한다. */
  const destroyedDelivery = (expireAt: Date | null) => ({ ...aliveDelivery(expireAt), deliveryTarget: '-' });

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

  it('폐기후재발행 tip 이 포함된 집합을 넘기면 tip 의 늦은 유효기간이 MAX 에 반영된다', () => {
    // 호출부 계약 고정 — 이 함수는 hideDiscardReissueDeliveries **이전** 집합을 받아야 한다.
    // 배치에는 replacedFromId 필터가 없어 tip 도 파기 대상이므로, tip 을 뺀 집합으로 계산하면
    // 실제보다 이른 날짜를 고지하게 된다(원본 2031-01-02 인데 tip 이 2031-06-02 까지 남는 식).
    const original = aliveDelivery(new Date('2030-12-31T00:00:00')); // → 2031-01-01
    const reissueTip = { ...aliveDelivery(new Date('2031-06-01T00:00:00')), replacedFromId: 1 }; // → 2031-06-02

    const withTip: any = { orderProductMappings: [mapping([original, reissueTip])] };
    const withoutTip: any = { orderProductMappings: [mapping([original])] };

    expect(ymd(resolveOrderEffectiveDestroyAt(withTip))).toBe('2031-06-02');
    // tip 을 걸러낸 집합을 넘기면 5개월 이른 날짜가 나온다 — 이 차이가 고지 오류의 크기다.
    expect(ymd(resolveOrderEffectiveDestroyAt(withoutTip))).toBe('2031-01-01');
  });

  it('일부만 조기파기된 주문 — 실적일과 예정일이 섞여도 MAX 의미가 유지된다', () => {
    // 발송건 2개 중 하나만 조기파기. 이미 지운 건의 실적일은 과거라 MAX 에 영향을 주지 않고,
    // 남은 건의 예정일이 "이 날이면 전부 지워져 있다"를 결정한다.
    const destroyed = { ...destroyedDelivery(new Date('2030-12-31T00:00:00')), id: 1 };
    const pending = { ...aliveDelivery(new Date('2026-03-01T00:00:00')), id: 2 }; // 예정 2026-06-30

    const order: any = { orderProductMappings: [mapping([destroyed, pending])] };
    const earlyMap = new Map<number, Date>([[1, new Date('2026-02-01T09:00:00')]]);

    expect(ymd(resolveOrderEffectiveDestroyAt(order, earlyMap))).toBe('2026-06-30');
    // 실적을 넘기지 않으면 조기파기된 건의 예정일(2031-01-01)이 MAX 를 지배해 5년 뒤가 된다.
    expect(ymd(resolveOrderEffectiveDestroyAt(order))).toBe('2031-01-01');
  });

  it('발송건이 없으면 null (증명할 내용이 없다)', () => {
    expect(resolveOrderEffectiveDestroyAt({ orderProductMappings: [mapping([])] } as any)).toBeNull();
    expect(resolveOrderEffectiveDestroyAt({ orderProductMappings: [] } as any)).toBeNull();
  });
});
