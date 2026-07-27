/**
 * 504 재발송 시간 정책 (§7.2). 타임존은 `Asia/Seoul(KST)` 고정이며,
 * 서버/DB 커넥션이 모두 KST(+09:00)이므로 로컬 시각 기준으로 계산한다.
 */

/** 허용 발송 시간대 시작(포함) — 08:00 KST */
export const RESEND_ALLOWED_START_HOUR = 8;
/** 허용 발송 시간대 종료(미포함) — 21:00 KST. 21:00~08:00 심야 발송은 하지 않는다. */
export const RESEND_ALLOWED_END_HOUR = 21;
/** 재발송 가능 기한 — **504 확정 시각** + 24h(달력 시간). 최초 접수 시각 기준이 아니다. */
export const RESEND_DEADLINE_MS = 24 * 60 * 60 * 1000;

/**
 * 재발송 예약 시각을 계산한다.
 *
 * `nextAttemptAt = max(504 확정시각, 다음 허용 발송 시작)` — 심야(21:00~08:00) 확정은 즉시 보내지 않고
 * 다음 허용 시작(익일 08:00)으로 미룬다. 504 확정 + 24h 윈도 안이라 익일 예약도 정상 재발송된다.
 */
export function computeNextAttemptAt(confirmedAt: Date): Date {
  const hour = confirmedAt.getHours();

  if (hour >= RESEND_ALLOWED_START_HOUR && hour < RESEND_ALLOWED_END_HOUR) {
    return new Date(confirmedAt.getTime());
  }

  const next = new Date(confirmedAt.getTime());
  if (hour >= RESEND_ALLOWED_END_HOUR) {
    // 21:00 이후 확정 → 익일 08:00
    next.setDate(next.getDate() + 1);
  }
  next.setHours(RESEND_ALLOWED_START_HOUR, 0, 0, 0);
  return next;
}

/** 재발송 가능 기한(504 확정 시각 + 24h). 판정 시점은 실제 실행(`dueResend`) 시점이다. */
export function computeResendDeadline(confirmedAt: Date): Date {
  return new Date(confirmedAt.getTime() + RESEND_DEADLINE_MS);
}

/** 실행 시점 기준 재발송 가능 여부. 기한을 넘겼으면 `FAILED_FINAL` 로 처리한다(기한 예외 승인 없음). */
export function isWithinResendDeadline(confirmedAt: Date, now: Date): boolean {
  return now.getTime() <= computeResendDeadline(confirmedAt).getTime();
}
