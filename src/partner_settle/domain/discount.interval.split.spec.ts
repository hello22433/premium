import { ActiveInterval, findTimelineViolation, planIntervalSplit } from './discount.interval.split';
import { IPartnerDiscountChangeType } from '../interface/partner.discount.change.type';

const d = (iso: string) => new Date(iso);

function interval(id: number, from: string, to: string | null, percent = 10): ActiveInterval {
  return {
    id,
    validFrom: d(from),
    validTo: to === null ? null : d(to),
    changeType: IPartnerDiscountChangeType.CREATE,
    pricePercent: percent,
    priceAdjustment: 'DISCOUNT',
  };
}

describe('planIntervalSplit', () => {
  it('이력이 없으면 CREATE 로 열린 구간 1건만 만든다', () => {
    const plan = planIntervalSplit([], d('2026-08-01T00:00:00Z'));

    expect(plan.ops).toEqual([]);
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]).toMatchObject({
      kind: 'NEW',
      changeType: IPartnerDiscountChangeType.CREATE,
      validTo: null,
    });
  });

  it('닫힌 구간 내부 소급은 기존 row 를 supersede 하고 복제+신값 2건을 넣는다', () => {
    const target = interval(1, '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z');
    const later = interval(2, '2026-07-01T00:00:00Z', null, 20);

    const plan = planIntervalSplit([target, later], d('2026-06-15T00:00:00Z'));

    expect(plan.ops).toEqual([{ op: 'SUPERSEDE', id: 1 }]);
    expect(plan.inserts).toHaveLength(2);
    // 앞부분은 기존 값 그대로, 뒷부분이 예약의 새 값이다.
    expect(plan.inserts[0]).toMatchObject({
      kind: 'CLONE',
      validFrom: d('2026-06-01T00:00:00Z'),
      validTo: d('2026-06-15T00:00:00Z'),
      source: target,
    });
    expect(plan.inserts[1]).toMatchObject({
      kind: 'NEW',
      validFrom: d('2026-06-15T00:00:00Z'),
      validTo: d('2026-07-01T00:00:00Z'),
    });
  });

  it('닫힌 구간 내부 소급이 뒤 구간을 건드리지 않는다', () => {
    const plan = planIntervalSplit(
      [interval(1, '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z'), interval(2, '2026-07-01T00:00:00Z', null, 20)],
      d('2026-06-15T00:00:00Z'),
    );

    expect(plan.ops.map((op) => op.id)).not.toContain(2);
  });

  it('닫힌 구간 경계 일치는 0길이 구간 없이 supersede 만 한다', () => {
    const plan = planIntervalSplit(
      [interval(1, '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z')],
      d('2026-06-01T00:00:00Z'),
    );

    expect(plan.ops).toEqual([{ op: 'SUPERSEDE', id: 1 }]);
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]).toMatchObject({
      kind: 'NEW',
      validFrom: d('2026-06-01T00:00:00Z'),
      validTo: d('2026-07-01T00:00:00Z'),
    });
  });

  it('pre-config 소급은 마감 대상 없이 최초 구간 앞을 독립 INSERT 한다', () => {
    const plan = planIntervalSplit([interval(1, '2026-06-01T00:00:00Z', null)], d('2026-05-01T00:00:00Z'));

    expect(plan.ops).toEqual([]);
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]).toMatchObject({
      kind: 'NEW',
      validFrom: d('2026-05-01T00:00:00Z'),
      validTo: d('2026-06-01T00:00:00Z'),
    });
  });

  // 열린 구간을 복제+supersede 로 처리하면 새 열린 구간 INSERT 가 UNIQUE(open_key) 에 걸린다.
  // 그래서 원본을 마감(CLOSE)해 앞부분을 계속 표현하게 하고, 새 값 구간 1건만 INSERT 한다.
  it('열린 구간 내부 분할은 원본을 마감하고 새 열린 구간 1건만 넣는다', () => {
    const plan = planIntervalSplit([interval(1, '2026-06-01T00:00:00Z', null)], d('2026-06-20T00:00:00Z'));

    expect(plan.ops).toEqual([{ op: 'CLOSE', id: 1, validTo: d('2026-06-20T00:00:00Z') }]);
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]).toMatchObject({
      kind: 'NEW',
      validFrom: d('2026-06-20T00:00:00Z'),
      validTo: null,
    });
  });

  // validTo = effectiveAt 은 validFrom < validTo CHECK 를 깬다. 남길 앞부분도 없으므로 퇴역시킨다.
  it('열린 구간 경계 일치는 RETIRE 로 open 슬롯을 비운다', () => {
    const plan = planIntervalSplit([interval(1, '2026-06-01T00:00:00Z', null)], d('2026-06-01T00:00:00Z'));

    expect(plan.ops).toEqual([{ op: 'RETIRE', id: 1 }]);
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]).toMatchObject({ kind: 'NEW', validFrom: d('2026-06-01T00:00:00Z'), validTo: null });
  });

  it('열린 구간이 있을 때 계획은 열린 구간을 2개로 만들지 않는다', () => {
    const cases: Array<[ActiveInterval[], Date]> = [
      [[interval(1, '2026-06-01T00:00:00Z', null)], d('2026-06-20T00:00:00Z')],
      [[interval(1, '2026-06-01T00:00:00Z', null)], d('2026-06-01T00:00:00Z')],
    ];

    for (const [intervals, at] of cases) {
      const plan = planIntervalSplit(intervals, at);
      const opened = plan.inserts.filter((i) => i.validTo === null).length;
      const freed = plan.ops.filter((op) => op.op === 'CLOSE' || op.op === 'RETIRE').length;
      expect(opened).toBe(1);
      expect(freed).toBe(1);
    }
  });

  it('마지막 닫힌 구간 뒤 시각은 열린 구간을 새로 연다', () => {
    const plan = planIntervalSplit(
      [interval(1, '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z')],
      d('2026-08-01T00:00:00Z'),
    );

    expect(plan.ops).toEqual([]);
    expect(plan.inserts[0]).toMatchObject({ kind: 'NEW', validFrom: d('2026-08-01T00:00:00Z'), validTo: null });
  });

  it('구간 사이 hole 은 다음 구간 시작까지만 채운다', () => {
    const plan = planIntervalSplit(
      [interval(1, '2026-06-01T00:00:00Z', '2026-06-10T00:00:00Z'), interval(2, '2026-07-01T00:00:00Z', null)],
      d('2026-06-20T00:00:00Z'),
    );

    expect(plan.ops).toEqual([]);
    expect(plan.inserts[0]).toMatchObject({ validFrom: d('2026-06-20T00:00:00Z'), validTo: d('2026-07-01T00:00:00Z') });
  });

  it('닫힌 tombstone 구간 내부 소급도 tombstone 값을 그대로 복제한다', () => {
    const tombstone: ActiveInterval = {
      id: 9,
      validFrom: d('2026-06-01T00:00:00Z'),
      validTo: d('2026-07-01T00:00:00Z'),
      changeType: IPartnerDiscountChangeType.DELETE,
      pricePercent: null,
      priceAdjustment: null,
    };

    const plan = planIntervalSplit([tombstone], d('2026-06-15T00:00:00Z'));

    expect(plan.inserts[0]).toMatchObject({ kind: 'CLONE', changeType: IPartnerDiscountChangeType.DELETE });
  });

  it('NEW 구간은 항상 정확히 1건 — resultHistoryId 대상이 모호해지지 않는다', () => {
    const cases: Array<[ActiveInterval[], Date]> = [
      [[], d('2026-08-01T00:00:00Z')],
      [[interval(1, '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z')], d('2026-06-15T00:00:00Z')],
      [[interval(1, '2026-06-01T00:00:00Z', null)], d('2026-06-01T00:00:00Z')],
      [[interval(1, '2026-06-01T00:00:00Z', null)], d('2026-05-01T00:00:00Z')],
    ];

    for (const [intervals, at] of cases) {
      expect(planIntervalSplit(intervals, at).inserts.filter((i) => i.kind === 'NEW')).toHaveLength(1);
    }
  });
});

describe('findTimelineViolation', () => {
  it('연속된 구간은 위반이 아니다', () => {
    const violation = findTimelineViolation([
      interval(1, '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z'),
      interval(2, '2026-07-01T00:00:00Z', null),
    ]);

    expect(violation).toBeNull();
  });

  it('겹치는 구간을 잡는다', () => {
    const violation = findTimelineViolation([
      interval(1, '2026-06-01T00:00:00Z', '2026-07-15T00:00:00Z'),
      interval(2, '2026-07-01T00:00:00Z', null),
    ]);

    expect(violation).toContain('겹칩니다');
  });

  it('열린 구간이 2개면 겹침으로 잡힌다', () => {
    const violation = findTimelineViolation([
      interval(1, '2026-06-01T00:00:00Z', null),
      interval(2, '2026-07-01T00:00:00Z', null),
    ]);

    expect(violation).toContain('겹칩니다');
  });

  it('validFrom 이 validTo 이상이면 잡는다', () => {
    const violation = findTimelineViolation([interval(1, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')]);

    expect(violation).toContain('validTo 이상');
  });

  it('hole 은 위반이 아니다 — 미설정 구간은 정상이다', () => {
    const violation = findTimelineViolation([
      interval(1, '2026-06-01T00:00:00Z', '2026-06-10T00:00:00Z'),
      interval(2, '2026-07-01T00:00:00Z', null),
    ]);

    expect(violation).toBeNull();
  });
});
