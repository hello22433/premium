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

  const alive = {
    deletedAt: null,
    couponStatus: OrderDeliveryCouponStatus.NOT_USED,
  };

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

  it('발송건이 없으면 null (증명할 내용이 없다)', () => {
    expect(resolveOrderEffectiveDestroyAt({ orderProductMappings: [mapping([])] } as any)).toBeNull();
    expect(resolveOrderEffectiveDestroyAt({ orderProductMappings: [] } as any)).toBeNull();
  });
});
