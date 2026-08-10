import { IPartnerDiscountChangeType } from '../interface/partner.discount.change.type';

/**
 * 정산조건 예약 발효 시의 구간 분할 계획 (정본 §8.6 · PR3B 명세 §4).
 *
 * 이 모듈은 **계획만 산출**하고 DB 는 건드리지 않는다. 반영은 서비스가 한다
 * (`discount.history.seed.ts` 와 같은 결).
 *
 * 기준 시각은 항상 **예약의 `effectiveAt`** 이다. cron 실행 시각이 아니다 — cron 은 정상 동작에서도
 * `effectiveAt` 보다 늦게 돌기 때문에, 실행 시각으로 구간을 열면 예약 시각과 `validFrom` 이 벌어지고
 * 그 사이 생성된 원장이 옛 조건으로 남는다.
 *
 * 닫힌 구간을 **제자리 수정하지 않는 것**이 이 설계의 핵심이다. 확정 원장이
 * `appliedDiscountHistoryId` 로 history row 를 참조하므로, 값이나 `validTo` 를 사후에 고치면 이미
 * 지급된 금액의 근거가 소리 없이 바뀐다. 그래서 닫힌 구간은 `supersededByHistoryId` 마킹만 하고
 * 필요한 구간을 새로 INSERT 한다.
 *
 * 반면 **열린 구간은 마감(`validTo` NULL → 시각)** 으로 처리한다. 엔티티 모델이 허용하는 1회 갱신이며
 * (`recordCreate`/`recordDelete` 의 `closeOpenInterval` 과 같은 패턴), 무엇보다 `UNIQUE(open_key)` 가
 * scope 당 열린 구간 1개만 허용하므로 **기존 열린 구간을 먼저 비우지 않으면 새 열린 구간 INSERT 가
 * duplicate key 로 실패한다.** 그래서 계획은 INSERT 뿐 아니라 **선행 마감/퇴역 op** 까지 산출한다.
 */

/** 분할 대상이 되는 활성 history 구간 (`supersededByHistoryId IS NULL`). */
export type ActiveInterval = {
  id: number;
  validFrom: Date;
  validTo: Date | null;
  changeType: IPartnerDiscountChangeType;
  pricePercent: number | null;
  priceAdjustment: string | null;
};

/**
 * INSERT 할 구간 1건.
 *
 * - `CLONE` = 기존 row 의 값을 그대로 옮겨 담는 앞부분 구간. `source` 에서 값을 가져온다.
 * - `NEW` = 예약이 적용하는 새 값 구간. **`resultHistoryId` 는 이 구간의 id 다.**
 */
export type PlannedInsert = {
  kind: 'CLONE' | 'NEW';
  changeType: IPartnerDiscountChangeType;
  validFrom: Date;
  validTo: Date | null;
  /** `CLONE` 일 때만 채워진다 — 복제 원본 row. */
  source: ActiveInterval | null;
};

/**
 * 기존 row 에 가할 조치.
 *
 * - `CLOSE` — 열린 구간을 `validTo` 로 마감한다. 앞부분은 그 row 가 그대로 계속 표현하므로 복제도
 *   supersede 도 필요 없다. **INSERT 보다 먼저** 실행해야 `open_key` 슬롯이 비워진다.
 * - `RETIRE` — 열린 구간인데 `validFrom == effectiveAt` 이라 남길 앞부분이 없는 경우.
 *   `validTo = effectiveAt` 은 `validFrom < validTo` CHECK 를 깨므로 마감할 수 없다. soft delete 로
 *   슬롯을 비우고(INSERT 전), INSERT 후 `supersededByHistoryId` 까지 건다.
 * - `SUPERSEDE` — 닫힌 구간 분할. 슬롯 문제가 없으므로 INSERT 뒤에 링크만 건다.
 */
export type IntervalOp =
  | { op: 'CLOSE'; id: number; validTo: Date }
  | { op: 'RETIRE'; id: number }
  | { op: 'SUPERSEDE'; id: number };

export type IntervalSplitPlan = {
  ops: IntervalOp[];
  /** 앞에서부터 순서대로 INSERT 한다. `NEW` 는 항상 정확히 1건이다. */
  inserts: PlannedInsert[];
};

/**
 * `effectiveAt` 위치별 분할 계획을 만든다.
 *
 * @param intervals 활성 구간 목록. 정렬은 이 함수가 한다.
 * @param effectiveAt 예약의 적용 시각.
 */
export function planIntervalSplit(intervals: ActiveInterval[], effectiveAt: Date): IntervalSplitPlan {
  const sorted = [...intervals].sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime());

  // 이력이 아예 없는 scope — 최초 설정이므로 CREATE 로 연다.
  if (sorted.length === 0) {
    return { ops: [], inserts: [newInterval(IPartnerDiscountChangeType.CREATE, effectiveAt, null)] };
  }

  const covering = sorted.find((interval) => covers(interval, effectiveAt));

  // 어떤 구간도 덮지 않는 시각 — pre-config 소급(최초 구간보다 앞), 구간 사이 hole, 마지막 구간 뒤.
  // 마감할 대상이 없으므로 op 없이 다음 구간 시작(없으면 open)까지 독립 INSERT 한다.
  // 마지막 구간 뒤라면 그 구간은 닫혀 있으므로(열려 있었다면 covering) 열린 구간이 겹치지 않는다.
  if (!covering) {
    const next = sorted.find((interval) => interval.validFrom.getTime() > effectiveAt.getTime());
    return {
      ops: [],
      inserts: [newInterval(IPartnerDiscountChangeType.UPDATE, effectiveAt, next ? next.validFrom : null)],
    };
  }

  const isBoundary = covering.validFrom.getTime() === effectiveAt.getTime();

  // 열린 구간을 덮는 경우 — 새 구간도 열린다. 기존 열린 구간을 먼저 비워야 open_key unique 를 통과한다.
  if (covering.validTo === null) {
    return {
      ops: [isBoundary ? { op: 'RETIRE', id: covering.id } : { op: 'CLOSE', id: covering.id, validTo: effectiveAt }],
      inserts: [newInterval(IPartnerDiscountChangeType.UPDATE, effectiveAt, null)],
    };
  }

  // 닫힌 구간 경계 일치 — 0길이 복제를 만들지 않기 위해 supersede 만 한다.
  if (isBoundary) {
    return {
      ops: [{ op: 'SUPERSEDE', id: covering.id }],
      inserts: [newInterval(IPartnerDiscountChangeType.UPDATE, effectiveAt, covering.validTo)],
    };
  }

  // 닫힌 구간 내부 — 앞부분을 기존 값으로 복제하고 뒤를 새 값으로 만든다. 원본은 제자리 수정하지 않는다.
  return {
    ops: [{ op: 'SUPERSEDE', id: covering.id }],
    inserts: [
      {
        kind: 'CLONE',
        changeType: covering.changeType,
        validFrom: covering.validFrom,
        validTo: effectiveAt,
        source: covering,
      },
      newInterval(IPartnerDiscountChangeType.UPDATE, effectiveAt, covering.validTo),
    ],
  };
}

function covers(interval: ActiveInterval, at: Date): boolean {
  if (interval.validFrom.getTime() > at.getTime()) return false;
  return interval.validTo === null || interval.validTo.getTime() > at.getTime();
}

function newInterval(changeType: IPartnerDiscountChangeType, validFrom: Date, validTo: Date | null): PlannedInsert {
  return { kind: 'NEW', changeType, validFrom, validTo, source: null };
}

/**
 * 반영 후 활성 timeline 불변식 검증 — `validFrom < validTo` · 무겹침.
 *
 * DB CHECK 는 row 단위 `validFrom < validTo` 만 막고 구간끼리의 겹침은 못 막는다(`open_key` unique 는
 * 열린 구간 1개만 보장). 겹침이 남으면 같은 occurredAt 에 두 할인율이 매칭돼 원장 금액이 실행 순서에
 * 따라 달라지므로, 커밋 전에 여기서 잡고 롤백한다.
 *
 * @returns 위반 사유. 문제 없으면 null.
 */
export function findTimelineViolation(intervals: ActiveInterval[]): string | null {
  const sorted = [...intervals].sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime());

  for (const interval of sorted) {
    if (interval.validTo !== null && interval.validFrom.getTime() >= interval.validTo.getTime()) {
      return `구간 ${interval.id} 의 validFrom 이 validTo 이상입니다.`;
    }
  }

  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const current = sorted[i];
    const next = sorted[i + 1];
    if (current.validTo === null || current.validTo.getTime() > next.validFrom.getTime()) {
      return `구간 ${current.id} 와 ${next.id} 가 겹칩니다.`;
    }
  }

  return null;
}
