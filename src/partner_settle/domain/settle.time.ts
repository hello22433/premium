/**
 * 정산 시각 규약 (정본 §6.7).
 *
 * 모든 정산 datetime 은 **KST 벽시계 기준 naive `DATETIME(6)`** 이다. 서버 TZ 가 `Asia/Seoul`
 * (`src/main.ts`)이고 DB 커넥션도 `+09:00` 이라, JS `Date` 의 로컬 시각이 곧 저장값이다.
 *
 * **원천 증적 시각은 원천이 준 정밀도를 그대로 보존한다** — 초 단위 원천은 `.000000`, 일 단위
 * 원천은 `00:00:00.000000` 으로 두고 임의 마이크로초를 부여하지 않는다(증적 변조 금지).
 * 같은 초에 사용→취소가 겹쳐도 occurredAt 은 같은 값이며, 순서는 `transitionSequenceNo` 로만
 * 구분한다(월 귀속은 어차피 동일하다).
 */

export class SettleTimeParseError extends Error {}

const COMPACT_DAY = /^(\d{4})(\d{2})(\d{2})$/;
const COMPACT_TIME = /^(\d{2})(\d{2})(\d{2})$/;
const COMPACT_DATE_TIME = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/;
const ISO_LIKE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?)?$/;

function build(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
  raw = '',
): Date {
  const date = new Date(year, month - 1, day, hour, minute, second, millisecond);
  // JS Date 는 2026-02-31 같은 값을 조용히 이월시킨다. 원천 오류를 시각으로 위조하지 않는다.
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    throw new SettleTimeParseError(`정산 시각 파싱 실패: ${raw || `${year}-${month}-${day}`}`);
  }
  return date;
}

/** 갤럭시아 `appDay`(YYYYMMDD) + `appTime`(HHmmss). 둘 중 하나라도 없으면 호출부가 orphan lane 으로 보낸다. */
export function parseDayAndTime(appDay: string, appTime: string): Date {
  const day = COMPACT_DAY.exec((appDay ?? '').trim());
  const time = COMPACT_TIME.exec((appTime ?? '').trim());
  if (!day || !time) {
    throw new SettleTimeParseError(`정산 시각 파싱 실패: ${appDay}/${appTime}`);
  }
  return build(+day[1], +day[2], +day[3], +time[1], +time[2], +time[3], 0, `${appDay}/${appTime}`);
}

/** 케이티알파 `exchDtm`·`cancelDtm`(YYYYMMDDHHmmss). */
export function parseCompactDateTime(value: string): Date {
  const matched = COMPACT_DATE_TIME.exec((value ?? '').trim());
  if (!matched) {
    throw new SettleTimeParseError(`정산 시각 파싱 실패: ${value}`);
  }
  return build(+matched[1], +matched[2], +matched[3], +matched[4], +matched[5], +matched[6], 0, value);
}

/**
 * 다우 `USE_DATE`·스푼 check `UseDate` 처럼 **일 단위**만 주는 원천.
 * 그 날 00:00:00.000000 으로 고정한다(임의 시각 보정 금지).
 */
export function parseDayOnly(value: string): Date {
  const raw = (value ?? '').trim();
  const compact = COMPACT_DAY.exec(raw);
  if (compact) return build(+compact[1], +compact[2], +compact[3], 0, 0, 0, 0, raw);

  const iso = ISO_LIKE.exec(raw);
  if (!iso) throw new SettleTimeParseError(`정산 일자 파싱 실패: ${value}`);
  return build(+iso[1], +iso[2], +iso[3], 0, 0, 0, 0, raw);
}

/**
 * KST naive 문자열(`YYYY-MM-DD HH:mm:ss[.ffffff]`) 또는 offset 명시 ISO-8601 을 KST 시각으로 정규화한다.
 * 같은 시각의 `+09:00` ISO 와 KST naive 는 **동일 저장값**이 되어야 한다(57차-H4).
 */
export function parseKstDateTime(value: string | Date): Date {
  if (value instanceof Date) return value;
  const raw = (value ?? '').trim();

  const naive = ISO_LIKE.exec(raw);
  if (naive) {
    const micro = naive[7] ?? '';
    if (micro.length > 6) throw new SettleTimeParseError(`마이크로초 정밀도 초과: ${value}`);
    const millisecond = micro === '' ? 0 : Math.floor(Number(micro.padEnd(6, '0')) / 1000);
    return build(
      +naive[1],
      +naive[2],
      +naive[3],
      naive[4] === undefined ? 0 : +naive[4],
      naive[5] === undefined ? 0 : +naive[5],
      naive[6] === undefined ? 0 : +naive[6],
      millisecond,
      raw,
    );
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new SettleTimeParseError(`정산 시각 파싱 실패: ${value}`);
  return parsed;
}

/** KST 월 시작(1일 00:00:00.000). */
export function startOfMonthKst(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), 1, 0, 0, 0, 0);
}

/** KST 다음 달 1일 00:00:00.000 — `periodEnd` 는 exclusive 경계다. */
export function nextMonthStartKst(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth() + 1, 1, 0, 0, 0, 0);
}

/**
 * 확정 sweep 술어 `occurredAt < periodEnd`.
 * `periodEnd` 정각은 **제외**, 직전 `23:59:59.999999` 는 포함이다. NULL occurredAt 은 자동 배제된다.
 */
export function isBeforePeriodEnd(occurredAt: Date | null, periodEnd: Date): boolean {
  if (occurredAt === null) return false;
  return occurredAt.getTime() < periodEnd.getTime();
}
