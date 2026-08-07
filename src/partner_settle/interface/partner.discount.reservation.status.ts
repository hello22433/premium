export enum IPartnerDiscountReservationStatus {
  PENDING = 'PENDING', // 발효 대기
  APPLIED = 'APPLIED', // 발효 완료 — history 구간 생성됨
  CANCELED = 'CANCELED', // 운영자 취소
  BLOCKED = 'BLOCKED', // 발효 시도가 정책 충돌로 거부됨. 자동 재시도 없음 — 취소 후 재예약이 유일한 해제 경로
}

/**
 * 발효 실패 코드. 재시도 여부가 코드마다 다르다.
 *
 * - `POLICY_CONFLICT` · `INTERVAL_INVARIANT` → BLOCKED (재시도 없음)
 * - `RETROACTIVE_DISABLED` → PENDING 유지 (flag on 시 자연 발효)
 */
export enum IPartnerDiscountReservationFailureCode {
  POLICY_CONFLICT = 'POLICY_CONFLICT',
  INTERVAL_INVARIANT = 'INTERVAL_INVARIANT',
  RETROACTIVE_DISABLED = 'RETROACTIVE_DISABLED',
}
