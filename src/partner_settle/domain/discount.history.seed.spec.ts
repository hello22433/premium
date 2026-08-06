import {
  buildSeedIntervals,
  PartnerDiscountSeedBounds,
  PartnerDiscountSeedError,
  PartnerDiscountSeedSourceRow,
} from './discount.history.seed';
import { IPartnerDiscountChangeType } from '../interface/partner.discount.change.type';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';

const BOUNDS: PartnerDiscountSeedBounds = {
  seedFloor: new Date('2000-01-01T00:00:00.000'),
  fromOccurredAt: new Date('2026-04-01T00:00:00.000'),
};

function row(overrides: Partial<PartnerDiscountSeedSourceRow> & { id: number }): PartnerDiscountSeedSourceRow {
  return {
    createdAt: new Date('2026-05-01T00:00:00.000'),
    deletedAt: null,
    pricePercent: 5,
    priceAdjustment: IPriceAdjustment.DISCOUNT,
    ...overrides,
  };
}

describe('buildSeedIntervals', () => {
  it('창 이전에 만들어진 활성 할인은 SEED_FLOOR 부터 열린 구간으로 복원한다', () => {
    const intervals = buildSeedIntervals([row({ id: 1, createdAt: new Date('2026-03-01T00:00:00.000') })], BOUNDS);

    expect(intervals).toHaveLength(1);
    expect(intervals[0]).toMatchObject({
      changeType: IPartnerDiscountChangeType.CREATE,
      pricePercent: 5,
      validFrom: BOUNDS.seedFloor,
      validTo: null,
    });
  });

  it('창 시작 후 처음 만들어진 할인은 생성 시각 이전으로 소급하지 않는다', () => {
    // 소급하면 최초 설정 전(창 시작~생성) 사건에 존재하지도 않던 할인이 적용된다.
    const intervals = buildSeedIntervals([row({ id: 1, createdAt: new Date('2026-05-01T00:00:00.000') })], BOUNDS);

    expect(intervals[0].validFrom).toEqual(new Date('2026-05-01T00:00:00.000'));
  });

  it('삭제된 할인은 값 구간 + tombstone 으로 복원한다', () => {
    const deletedAt = new Date('2026-06-01T00:00:00.000');
    const intervals = buildSeedIntervals([row({ id: 1, deletedAt })], BOUNDS);

    expect(intervals).toHaveLength(2);
    expect(intervals[0]).toMatchObject({ changeType: IPartnerDiscountChangeType.CREATE, validTo: deletedAt });
    expect(intervals[1]).toMatchObject({
      changeType: IPartnerDiscountChangeType.DELETE,
      pricePercent: null,
      priceAdjustment: null,
      validFrom: deletedAt,
      validTo: null,
    });
  });

  it('삭제 후 재생성은 값 → tombstone → 새 값 순으로 이어지고 재생성 값은 소급하지 않는다', () => {
    const deletedAt = new Date('2026-06-01T00:00:00.000');
    const recreatedAt = new Date('2026-07-01T00:00:00.000');

    const intervals = buildSeedIntervals(
      [
        row({ id: 1, createdAt: new Date('2026-03-01T00:00:00.000'), deletedAt, pricePercent: 5 }),
        row({ id: 2, createdAt: recreatedAt, pricePercent: 7 }),
      ],
      BOUNDS,
    );

    expect(intervals).toHaveLength(3);
    expect(intervals[0]).toMatchObject({ pricePercent: 5, validFrom: BOUNDS.seedFloor, validTo: deletedAt });
    expect(intervals[1]).toMatchObject({
      changeType: IPartnerDiscountChangeType.DELETE,
      validFrom: deletedAt,
      validTo: recreatedAt,
    });
    expect(intervals[2]).toMatchObject({ pricePercent: 7, validFrom: recreatedAt, validTo: null });
  });

  it('구간이 빈틈 없이 이어진다', () => {
    const intervals = buildSeedIntervals(
      [
        row({ id: 1, createdAt: new Date('2026-05-01T00:00:00.000'), deletedAt: new Date('2026-06-01T00:00:00.000') }),
        row({ id: 2, createdAt: new Date('2026-07-01T00:00:00.000') }),
      ],
      BOUNDS,
    );

    for (let i = 0; i < intervals.length - 1; i += 1) {
      expect(intervals[i].validTo).toEqual(intervals[i + 1].validFrom);
    }
    expect(intervals.filter((interval) => interval.validTo === null)).toHaveLength(1);
  });

  it('삭제와 재생성이 같은 시각이면 0길이 tombstone 을 만들지 않는다', () => {
    const at = new Date('2026-06-01T00:00:00.000');
    const intervals = buildSeedIntervals(
      [row({ id: 1, deletedAt: at }), row({ id: 2, createdAt: at, pricePercent: 9 })],
      BOUNDS,
    );

    expect(intervals.map((interval) => interval.changeType)).toEqual([
      IPartnerDiscountChangeType.CREATE,
      IPartnerDiscountChangeType.CREATE,
    ]);
    expect(intervals[0].validTo).toEqual(at);
    expect(intervals[1].validFrom).toEqual(at);
  });

  it('lifecycle 이 겹치면 근사하지 않고 실패한다', () => {
    expect(() =>
      buildSeedIntervals(
        [
          row({ id: 1, deletedAt: new Date('2026-06-01T00:00:00.000') }),
          row({ id: 2, createdAt: new Date('2026-05-15T00:00:00.000') }),
        ],
        BOUNDS,
      ),
    ).toThrow(PartnerDiscountSeedError);
  });

  it('활성 할인이 2건이면 어느 값이 유효한지 결정할 수 없어 실패한다', () => {
    expect(() =>
      buildSeedIntervals(
        [row({ id: 1 }), row({ id: 2, createdAt: new Date('2026-06-01T00:00:00.000') })],
        BOUNDS,
      ),
    ).toThrow(PartnerDiscountSeedError);
  });

  it('생성·삭제 시각이 역전되면 실패한다', () => {
    expect(() =>
      buildSeedIntervals(
        [row({ id: 1, createdAt: new Date('2026-05-01T00:00:00.000'), deletedAt: new Date('2026-04-01T00:00:00.000') })],
        BOUNDS,
      ),
    ).toThrow(PartnerDiscountSeedError);
  });
});
