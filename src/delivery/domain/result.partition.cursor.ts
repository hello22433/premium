/**
 * 결과 파티션 증분 탐색 커서 (§7.3).
 *
 * `MSG_RESULT_yyyyMM` 는 **확정(`REPORT_TIME`)월 파티션**(`RESULT_BACKUP_SAME_MONTH=N`)이라
 * 지연 확정 결과가 접수월+1·+2… 뒤 월 테이블에 들어올 수 있다. 매 사이클 전체 월을 훑지 않고
 * `next_search_month ~ 현재월` 범위만 조회한다.
 *
 * 규칙:
 * - **상한은 현재월** — 확정은 미래월 테이블에 들어올 수 없다.
 * - **닫힌 과거월은 1회만** 조회하고, **현재월만 매 사이클 재조회**한다(행이 계속 유입).
 * - 다음 시작월 = 현재월 → 월 롤오버 시 직전월(이제 닫힘)을 한 번 더 훑고 진행한다.
 */
const MONTH_PATTERN = /^\d{6}$/;

/** `Date` → `yyyyMM`. 커넥션 타임존이 KST 고정이라 로컬 시각을 쓴다. */
export function toYearMonth(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** `yyyyMM` 형식 검증. 동적 테이블명에 쓰이므로 호출 전 반드시 통과해야 한다(주입 차단). */
export function isYearMonth(value: string | null | undefined): value is string {
  return typeof value === 'string' && MONTH_PATTERN.test(value);
}

/** `yyyyMM` 를 1개월 증가시킨다. */
export function nextYearMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(4, 6));
  return mon === 12 ? `${year + 1}01` : `${year}${String(mon + 1).padStart(2, '0')}`;
}

/**
 * 이번 사이클에 조회할 월 목록을 만든다(오름차순, 상한=현재월).
 *
 * @param startMonth `next_search_month ?? receipt_month`
 * @param currentMonth 현재월(`yyyyMM`)
 */
export function monthsToSearch(startMonth: string, currentMonth: string): string[] {
  if (!isYearMonth(startMonth) || !isYearMonth(currentMonth) || startMonth > currentMonth) {
    return [];
  }

  const months: string[] = [];
  let cursor = startMonth;
  // 방어적 상한(10년) — 커서 오염 시 무한 루프를 막는다.
  for (let i = 0; i < 120 && cursor <= currentMonth; i++) {
    months.push(cursor);
    cursor = nextYearMonth(cursor);
  }

  return months;
}

/**
 * 미확정으로 사이클을 마쳤을 때의 커서 갱신값.
 * 닫힌 과거월은 다시 보지 않고, 현재월은 다음 사이클에 재조회한다.
 */
export function advanceCursor(currentMonth: string): { lastSearchedMonth: string; nextSearchMonth: string } {
  return { lastSearchedMonth: currentMonth, nextSearchMonth: currentMonth };
}
