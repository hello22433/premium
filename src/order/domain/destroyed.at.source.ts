/**
 * order_delivery.destroyed_at 의 출처.
 *
 * 파기일이 **사실인지 추정인지**를 판별하는 유일한 근거다. 날짜 값만으로는 구분할 수 없고
 * (시각 기반 추론은 양방향으로 틀린다 — order.delivery.entity.ts 의 destroyedAtSource 주석 참조),
 * 이 값이 파기확인서라는 대외 증빙에 나가므로 출처를 데이터에 남긴다.
 *
 * 이 상수는 런타임 각인 경로가 쓴다. 백필 값(BACKFILL_*)은 migration/order-delivery-destroyed-at.sql
 * 이 직접 문자열로 넣으므로 여기서 참조되지 않지만, **같은 어휘를 쓰는 곳이 둘**이라는 사실을
 * 드러내기 위해 전부 나열한다. 한쪽을 바꾸면 다른 쪽도 바꿔야 한다.
 */
export const DESTROYED_AT_SOURCE = {
  /** 조기파기 실행 시 각인 (early.destroy.service). 사실. */
  EARLY: 'EARLY',
  /** 정기파기 배치 실행 시 각인 (delivery.batch.service). 사실. */
  BATCH: 'BATCH',
  /** 컬럼 신설 백필 §2 — early_destroy_request.executed_at 복사. 사실. */
  BACKFILL_EARLY: 'BACKFILL_EARLY',
  /** 컬럼 신설 백필 §3 — `발송요청일 + 파기일수` 계산값. **추정**. */
  BACKFILL_ESTIMATE: 'BACKFILL_ESTIMATE',
} as const;

export type DestroyedAtSource = (typeof DESTROYED_AT_SOURCE)[keyof typeof DESTROYED_AT_SOURCE];

/**
 * 이 값이 추정인가. 사실/추정 축에서는 BACKFILL_ESTIMATE 하나만 추정이다.
 *
 * NULL 은 "출처를 모른다"이므로 사실이라고 단정할 수 없다 — 추정으로 취급한다(fail-closed).
 * 대외 증빙에서 "모른다"를 "사실"로 승격시키면 그게 곧 허위 진술이 되기 때문이다.
 */
export const isEstimatedDestroyedAt = (source: string | null | undefined): boolean =>
  source !== DESTROYED_AT_SOURCE.EARLY &&
  source !== DESTROYED_AT_SOURCE.BATCH &&
  source !== DESTROYED_AT_SOURCE.BACKFILL_EARLY;
