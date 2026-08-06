/**
 * inbox lane 구분 (정본 §5.12 origin).
 *
 * `ORPHAN` 은 관측 lane 이 아니다 — observation 을 만들지 않고 자동 dedup·PENDING 복구 대상도 아니다.
 */
export type IPartnerProviderEventOrigin = 'POLL' | 'PUSH' | 'MANUAL' | 'ORPHAN';

/**
 * inbox 처리 상태 (정본 §5.12 processedStatus).
 *
 * 관측 lane: `PENDING → LINKED` 1회 CAS.
 * orphan lane: `ORPHAN_PENDING` 에서 아래 3종 terminal 중 정확히 하나로만 1회 CAS 한다.
 * - `ORPHAN_LEDGERED`      수동 LEDGER 승인 (PR1C)
 * - `ORPHAN_AUTO_LEDGERED` 시각 완비 후 자동 producer claim (PR1B)
 * - `ORPHAN_DISCARDED`     수동 DISCARD 승인 = 비정산 폐기 (PR1C)
 *
 * `SKIPPED` 는 없다 — 무변화 재조회는 신규 row 를 만들지 않는다.
 */
export type IPartnerProviderEventProcessedStatus =
  | 'PENDING'
  | 'LINKED'
  | 'ORPHAN_PENDING'
  | 'ORPHAN_LEDGERED'
  | 'ORPHAN_AUTO_LEDGERED'
  | 'ORPHAN_DISCARDED';

/** 전이 관측 해소 상태 (정본 §5.15.8). */
export type IPartnerSettleObservationResolutionStatus = 'RESOLVED' | 'UNRESOLVED';
