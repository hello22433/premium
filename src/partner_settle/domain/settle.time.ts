/**
 * 정산 시각 규약 (정본 §6.7).
 *
 * 모든 정산 datetime 은 **KST 벽시계 기준 naive `DATETIME(6)`** 이다. 서버 TZ 가 `Asia/Seoul`
 * (`src/main.ts`)이고 DB 커넥션도 `+09:00` 이라, KST 로컬 시각이 곧 저장값이다.
 *
 * ⚠️ **JS `Date` 는 밀리초까지만 표현한다.** `Date` 하나로 다루면 `.123456` 요청이 `.123000` 으로
 * 저장되어 증적 시각이 조용히 변조되고, 같은 사건의 멱등 재시도가 다른 hash 로 갈린다. 그래서
 * 이 파일은 **`KstInstant`(밀리초 `Date` + 밀리초 미만 잔여 마이크로초)** 로 다루고, DB 저장·hash 는
 * 반드시 `toDbDateTimeString()` canonical 문자열을 쓴다.
 *
 * **원천 증적 시각은 원천이 준 정밀도를 그대로 보존한다** — 초 단위 원천은 `.000000`, 일 단위
 * 원천은 `00:00:00.000000` 으로 두고 임의 마이크로초를 부여하지 않는다(증적 변조 금지).
 * 같은 초에 사용→취소가 겹쳐도 occurredAt 은 같은 값이며, 순서는 `transitionSequenceNo` 로만
 * 구분한다(월 귀속은 어차피 동일하다).
 */

export class SettleTimeParseError extends Error {}

/**
 * KST naive `DATETIME(6)` 값.
 *
 * `date` 는 밀리초까지, `microsecondRemainder`(0~999)는 밀리초 미만 잔여다.
 * 전체 마이크로초 = `date.getMilliseconds() * 1000 + microsecondRemainder`.
 */
export type KstInstant = {
  readonly date: Date;
  readonly microsecondRemainder: number;
};

const COMPACT_DAY = /^(\d{4})(\d{2})(\d{2})$/;
const COMPACT_TIME = /^(\d{2})(\d{2})(\d{2})$/;
const COMPACT_DATE_TIME = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/;
const ISO_LIKE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?)?$/;
const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/;

/** 초 정밀도 원천용 — 잔여 마이크로초 0. */
export function fromDate(date: Date): KstInstant {
  return { date: new Date(date.getTime()), microsecondRemainder: 0 };
}

function build(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  microsecond: number,
  raw: string,
): KstInstant {
  const millisecond = Math.floor(microsecond / 1000);
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
  return { date, microsecondRemainder: microsecond % 1000 };
}

/** 갤럭시아 `appDay`(YYYYMMDD) + `appTime`(HHmmss). 둘 중 하나라도 없으면 호출부가 orphan lane 으로 보낸다. */
export function parseDayAndTime(appDay: string, appTime: string): KstInstant {
  const day = COMPACT_DAY.exec((appDay ?? '').trim());
  const time = COMPACT_TIME.exec((appTime ?? '').trim());
  if (!day || !time) {
    throw new SettleTimeParseError(`정산 시각 파싱 실패: ${appDay}/${appTime}`);
  }
  return build(+day[1], +day[2], +day[3], +time[1], +time[2], +time[3], 0, `${appDay}/${appTime}`);
}

/** 케이티알파 `exchDtm`·`cancelDtm`(YYYYMMDDHHmmss). */
export function parseCompactDateTime(value: string): KstInstant {
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
export function parseDayOnly(value: string): KstInstant {
  const raw = (value ?? '').trim();
  const compact = COMPACT_DAY.exec(raw);
  if (compact) return build(+compact[1], +compact[2], +compact[3], 0, 0, 0, 0, raw);

  const iso = ISO_LIKE.exec(raw);
  if (!iso) throw new SettleTimeParseError(`정산 일자 파싱 실패: ${value}`);
  return build(+iso[1], +iso[2], +iso[3], 0, 0, 0, 0, raw);
}

/**
 * KST naive 문자열(`YYYY-MM-DD HH:mm:ss[.ffffff]`) 또는 offset 명시 ISO-8601 을 KST 로 정규화한다.
 * 같은 시각의 `+09:00` ISO 와 KST naive 는 **동일 저장값**이 되어야 한다(57차-H4).
 * 마이크로초는 6자리까지 보존하고 7자리 이상은 거부한다.
 */
export function parseKstDateTime(value: string | Date): KstInstant {
  if (value instanceof Date) return fromDate(value);
  const raw = (value ?? '').trim();

  const offsetMatched = ISO_WITH_OFFSET.exec(raw);
  if (offsetMatched) return parseWithOffset(offsetMatched, raw);

  const naive = ISO_LIKE.exec(raw);
  if (!naive) throw new SettleTimeParseError(`정산 시각 파싱 실패: ${value}`);

  return build(
    +naive[1],
    +naive[2],
    +naive[3],
    naive[4] === undefined ? 0 : +naive[4],
    naive[5] === undefined ? 0 : +naive[5],
    naive[6] === undefined ? 0 : +naive[6],
    parseMicrosecond(naive[7], raw),
    raw,
  );
}

/** offset 입력은 KST(+09:00)로 변환한다. 마이크로초는 변환에 영향받지 않으므로 그대로 옮긴다. */
function parseWithOffset(matched: RegExpExecArray, raw: string): KstInstant {
  const microsecond = parseMicrosecond(matched[7], raw);
  const offset = matched[8];
  const offsetMinutes =
    offset === 'Z'
      ? 0
      : (offset.startsWith('-') ? -1 : 1) *
        (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(-2)));

  const utcMs = Date.UTC(
    +matched[1],
    +matched[2] - 1,
    +matched[3],
    +matched[4],
    +matched[5],
    +matched[6],
    Math.floor(microsecond / 1000),
  );
  const kst = new Date(utcMs - offsetMinutes * 60_000 + 9 * 60 * 60_000);

  // KST 벽시계 값을 로컬 Date 로 재구성한다(서버 TZ 가 KST 가 아닌 환경에서도 저장값이 같아야 한다).
  return build(
    kst.getUTCFullYear(),
    kst.getUTCMonth() + 1,
    kst.getUTCDate(),
    kst.getUTCHours(),
    kst.getUTCMinutes(),
    kst.getUTCSeconds(),
    microsecond,
    raw,
  );
}

function parseMicrosecond(fraction: string | undefined, raw: string): number {
  if (fraction === undefined || fraction === '') return 0;
  if (fraction.length > 6) throw new SettleTimeParseError(`마이크로초 정밀도 초과: ${raw}`);
  return Number(fraction.padEnd(6, '0'));
}

/**
 * DB 저장·payload hash 의 canonical 표현 `YYYY-MM-DD HH:mm:ss.ffffff`.
 * **`Date` 를 그대로 넘기면 마이크로초가 잘리므로 저장 경로는 반드시 이 함수를 쓴다.**
 */
export function toDbDateTimeString(instant: KstInstant): string {
  const d = instant.date;
  const microsecond = d.getMilliseconds() * 1000 + instant.microsecondRemainder;
  return (
    `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)} ` +
    `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(microsecond, 6)}`
  );
}

/** 전체 마이크로초(밀리초 × 1000 + 잔여). 동일 시각 판정·정렬에 쓴다. */
export function totalMicroseconds(instant: KstInstant): number {
  return instant.date.getTime() * 1000 + instant.microsecondRemainder;
}

export function compareInstant(a: KstInstant, b: KstInstant): number {
  return totalMicroseconds(a) - totalMicroseconds(b);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** KST 월 시작(1일 00:00:00.000000). */
export function startOfMonthKst(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), 1, 0, 0, 0, 0);
}

/** KST 다음 달 1일 00:00:00.000000 — `periodEnd` 는 exclusive 경계다. */
export function nextMonthStartKst(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth() + 1, 1, 0, 0, 0, 0);
}

/**
 * 확정 sweep 술어 `occurredAt < periodEnd`.
 *
 * `periodEnd` 정각은 **제외**, 직전 `23:59:59.999999` 는 포함이다(밀리초 미만 잔여까지 비교한다).
 * NULL occurredAt 은 자동 배제된다.
 */
export function isBeforePeriodEnd(occurredAt: KstInstant | null, periodEnd: Date): boolean {
  if (occurredAt === null) return false;
  return totalMicroseconds(occurredAt) < periodEnd.getTime() * 1000;
}
