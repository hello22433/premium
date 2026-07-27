/**
 * 자동 발송 허용 시간대 정책 (§7.2 + 2026-07-27 운영 확정).
 *
 * 타임존은 `Asia/Seoul(KST)` 고정이며, 서버/DB 커넥션이 모두 KST(+09:00)이라 로컬 시각으로 계산한다.
 *
 * **자동 발송(504 재발송·알림톡 SMS 폴백)은 08:00–20:00 KST 에서만** 수행한다.
 * 주문 작성의 예약발송 선택 시간대가 이미 심야를 배제하고 있고, 광고성 정보 전송 제한(심야 발송 금지)에
 * 걸릴 위험을 원천 차단하기 위함이다. 운영자 수동 재발송은 사람이 판단하는 행위이므로 대상이 아니다.
 */

/** 허용 발송 시간대 시작(포함) — 08:00 KST */
export const RESEND_ALLOWED_START_HOUR = 8;
/** 허용 발송 시간대 종료(미포함) — 20:00 KST. 20:00~08:00 자동 발송은 하지 않는다. */
export const RESEND_ALLOWED_END_HOUR = 20;
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

/**
 * 자동 발송 허용 시간대 안인지 판정한다(08:00–20:00 KST).
 *
 * 알림톡 SMS 폴백처럼 **배치가 스스로 트리거하는 발송**은 이 창 밖에서 수행하지 않는다.
 * 창 밖이면 발송을 버리지 않고 `computeNextAttemptAt` 이 주는 다음 허용 시작으로 미룬다.
 */
export function isWithinAllowedSendWindow(now: Date): boolean {
  const hour = now.getHours();
  return hour >= RESEND_ALLOWED_START_HOUR && hour < RESEND_ALLOWED_END_HOUR;
}
