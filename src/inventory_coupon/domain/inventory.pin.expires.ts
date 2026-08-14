/**
 * PIN 유효기간(`inventory_pin_item.expires_on`, DATE) 정규화.
 *
 * 엑셀 입고와 수동 등록이 **같은 함수**를 쓴다. 한쪽만 정규화하면
 * `2026-8-1` 같은 값이 문자열 비교를 통과해 만료 PIN 이 재고로 들어간다.
 */

/** 해석 불가 유효기간 마커. null(무기한)과 반드시 구분해야 한다. */
export const INVALID_EXPIRES_ON = Symbol('INVALID_EXPIRES_ON');

export type NormalizedExpiresOn = string | null | typeof INVALID_EXPIRES_ON;

/**
 * 엑셀 셀 값 / API 문자열 → `YYYY-MM-DD`.
 *
 * 허용: Date(엑셀 날짜 셀), `YYYY-MM-DD`, `YYYY.M.D`, `YYYY/M/D`, `YYYYMMDD`.
 * 빈 값은 무기한(null), 그 외는 `INVALID_EXPIRES_ON`.
 */
export function normalizeExpiresOn(value: unknown): NormalizedExpiresOn {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return INVALID_EXPIRES_ON;
    // ExcelJS 는 날짜 셀을 UTC 자정 Date 로 준다. 로컬 변환하면 하루가 밀린다.
    return value.toISOString().slice(0, 10);
  }

  if (typeof value !== 'string' && typeof value !== 'number') return INVALID_EXPIRES_ON;

  const text = String(value).trim();
  if (!text) return null;

  // 구분자는 -, ., / 만 허용하고 월/일 한 자리 표기(2026-8-1)도 받아 0 을 채운다.
  const parts = text.split(/[.\-/]/).filter((part) => part !== '');
  let iso: string;

  if (parts.length === 3) {
    const [year, month, day] = parts;
    if (!/^\d{4}$/.test(year) || !/^\d{1,2}$/.test(month) || !/^\d{1,2}$/.test(day)) {
      return INVALID_EXPIRES_ON;
    }
    iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  } else if (parts.length === 1 && /^\d{8}$/.test(parts[0])) {
    iso = `${parts[0].slice(0, 4)}-${parts[0].slice(4, 6)}-${parts[0].slice(6, 8)}`;
  } else {
    return INVALID_EXPIRES_ON;
  }

  // 2026-02-31 처럼 존재하지 않는 날짜는 Date 가 다른 날로 굴러가므로 왕복 비교로 거른다.
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    return INVALID_EXPIRES_ON;
  }
  return iso;
}

/** KST 기준 오늘(`YYYY-MM-DD`). 유효기간은 KST 날짜 계약이라 서버 TZ 에 의존하지 않는다. */
export function todayInKst(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
