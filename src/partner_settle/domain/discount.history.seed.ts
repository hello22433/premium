import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { IPartnerDiscountChangeType } from '../interface/partner.discount.change.type';

/**
 * 초기 seed — soft-delete 된 `user_discount` 까지 포함해 scope 의 lifecycle 을 이력 구간으로 복원한다.
 *
 * "현재 활성 row 만 SEED_FLOOR 부터 커버" 하는 단순 baseline 은 cutover 이전 삭제 이력을 지운다.
 * 예: 5월 5% 설정 → 6월 삭제 → 7월 seed 에서 삭제 row 를 빼면, backfill 하한이 5월까지 내려갈 때
 * 5월 사건이 "이력 없음 = 0%" 로 오계산되고, 삭제 후 재생성된 scope 는 현재값이 SEED_FLOOR 까지
 * 잘못 소급되어 이전 값과 삭제 공백이 사라진다.
 */

export type PartnerDiscountSeedSourceRow = {
  id: number;
  createdAt: Date;
  deletedAt: Date | null;
  pricePercent: number;
  priceAdjustment: IPriceAdjustment;
};

export type PartnerDiscountSeedInterval = {
  changeType: IPartnerDiscountChangeType;
  pricePercent: number | null;
  priceAdjustment: IPriceAdjustment | null;
  validFrom: Date;
  validTo: Date | null;
  sourceDiscountId: number;
};

export type PartnerDiscountSeedBounds = {
  /** 이 시각 이전은 정산 대상이 아니므로 근사(baseline 소급)를 허용한다. */
  seedFloor: Date;
  /** backfill 창 하한. 창 시작 후 최초 생성된 scope 는 그 이전으로 소급하지 않는다. */
  fromOccurredAt: Date;
};

export class PartnerDiscountSeedError extends Error {}

/**
 * 한 scope 의 lifecycle 을 구간으로 변환한다.
 *
 * 판단 불가한 입력은 근사하지 않고 던진다 — seed 는 배포 게이트라, 임의 계산으로 통과시키면
 * 잘못된 매입율이 영구히 박제된다.
 */
export function buildSeedIntervals(
  rows: PartnerDiscountSeedSourceRow[],
  bounds: PartnerDiscountSeedBounds,
): PartnerDiscountSeedInterval[] {
  const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);
  const intervals: PartnerDiscountSeedInterval[] = [];

  for (let i = 0; i < sorted.length; i += 1) {
    const row = sorted[i];
    const next = sorted[i + 1];

    if (row.deletedAt === null && next) {
      throw new PartnerDiscountSeedError(
        `삭제되지 않은 할인(${row.id}) 뒤에 같은 scope 의 다른 할인(${next.id})이 있습니다.`,
      );
    }
    if (next && row.deletedAt && next.createdAt < row.deletedAt) {
      throw new PartnerDiscountSeedError(
        `lifecycle 겹침: 할인 ${row.id} 삭제(${row.deletedAt.toISOString()}) 전에 ${next.id} 이 생성됐습니다.`,
      );
    }

    // 최초 row 만 창 이전 존재를 근거로 SEED_FLOOR 까지 내린다.
    // 재생성 row 를 소급하면 삭제 공백이 사라지고 최초 설정 전 사건에 할인이 오적용된다.
    const validFrom = i === 0 && row.createdAt <= bounds.fromOccurredAt ? bounds.seedFloor : row.createdAt;

    if (row.deletedAt && row.deletedAt <= validFrom) {
      throw new PartnerDiscountSeedError(`할인 ${row.id} 의 생성·삭제 시각이 역전됐거나 같습니다.`);
    }

    intervals.push({
      changeType: IPartnerDiscountChangeType.CREATE,
      pricePercent: row.pricePercent,
      priceAdjustment: row.priceAdjustment,
      validFrom,
      validTo: row.deletedAt,
      sourceDiscountId: row.id,
    });

    // 삭제와 재생성이 같은 시각이면 비활성 구간이 존재하지 않는다.
    // 0길이 tombstone 을 넣으면 `valid_from < valid_to` 를 깨고, 넣지 않아도 구간은 그대로 이어진다.
    const needsTombstone = row.deletedAt !== null && (!next || next.createdAt > row.deletedAt);

    if (row.deletedAt && needsTombstone) {
      intervals.push({
        changeType: IPartnerDiscountChangeType.DELETE,
        pricePercent: null,
        priceAdjustment: null,
        validFrom: row.deletedAt,
        validTo: next ? next.createdAt : null,
        sourceDiscountId: row.id,
      });
    }
  }

  return intervals;
}
