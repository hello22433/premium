import {
  compareInstant,
  fromDate,
  isBeforePeriodEnd,
  nextMonthStartKst,
  parseCompactDateTime,
  parseDayAndTime,
  parseDayOnly,
  parseKstDateTime,
  SettleTimeParseError,
  startOfMonthKst,
  toDbDateTimeString,
  totalMicroseconds,
} from './settle.time';

describe('원천 시각 파싱 — 정밀도 보존', () => {
  it('갤럭시아 appDay+appTime 은 초 정밀도로 읽고 .000000 으로 저장한다', () => {
    const parsed = parseDayAndTime('20260630', '235959');
    expect(toDbDateTimeString(parsed)).toBe('2026-06-30 23:59:59.000000');
  });

  it('케이티알파 exchDtm(YYYYMMDDHHmmss) 을 읽는다', () => {
    expect(toDbDateTimeString(parseCompactDateTime('20260701000000'))).toBe('2026-07-01 00:00:00.000000');
  });

  it('일 단위 원천은 그 날 00:00:00 으로 고정한다 (임의 시각 부여 금지)', () => {
    for (const raw of ['20260706', '2026-07-06']) {
      expect(toDbDateTimeString(parseDayOnly(raw))).toBe('2026-07-06 00:00:00.000000');
    }
  });

  it('존재하지 않는 날짜를 조용히 이월시키지 않는다', () => {
    expect(() => parseDayOnly('20260231')).toThrow(SettleTimeParseError);
    expect(() => parseDayAndTime('20260630', '246000')).toThrow(SettleTimeParseError);
  });

  it('형식 위반은 파싱 실패다 (감지 시각으로 대체하지 않는다)', () => {
    expect(() => parseCompactDateTime('2026070100')).toThrow(SettleTimeParseError);
    expect(() => parseDayAndTime('', '')).toThrow(SettleTimeParseError);
  });
});

describe('요청 datetime canonicalization (57차-H4)', () => {
  it('마이크로초를 밀리초로 절삭하지 않는다 — DATETIME(6) 저장값이 원문과 같다', () => {
    const instant = parseKstDateTime('2026-07-06 13:24:35.123456');
    expect(toDbDateTimeString(instant)).toBe('2026-07-06 13:24:35.123456');
    // Date 로만 다뤘다면 .123000 이 되어 증적 시각이 변조된다.
    expect(toDbDateTimeString(fromDate(instant.date))).toBe('2026-07-06 13:24:35.123000');
  });

  it('마이크로초 자릿수가 부족하면 0-pad 한다', () => {
    expect(toDbDateTimeString(parseKstDateTime('2026-07-06 13:24:35.1'))).toBe('2026-07-06 13:24:35.100000');
  });

  it('7자리 이상 마이크로초는 거부한다', () => {
    expect(() => parseKstDateTime('2026-07-06 13:24:35.1234567')).toThrow(SettleTimeParseError);
  });

  it('같은 시각의 +09:00 ISO 와 KST naive 는 동일 저장값이다 (마이크로초 포함)', () => {
    const naive = parseKstDateTime('2026-07-06 13:24:35.123456');
    const offset = parseKstDateTime('2026-07-06T13:24:35.123456+09:00');
    expect(toDbDateTimeString(offset)).toBe(toDbDateTimeString(naive));
    expect(compareInstant(offset, naive)).toBe(0);
  });

  it('다른 offset 은 KST 벽시계로 변환된다', () => {
    const utc = parseKstDateTime('2026-07-06T04:24:35Z');
    expect(toDbDateTimeString(utc)).toBe('2026-07-06 13:24:35.000000');
  });

  it('마이크로초만 다른 두 시각은 서로 다른 값으로 구분된다', () => {
    const a = parseKstDateTime('2026-07-06 13:24:35.123456');
    const b = parseKstDateTime('2026-07-06 13:24:35.123457');
    expect(compareInstant(a, b)).toBeLessThan(0);
    expect(totalMicroseconds(b) - totalMicroseconds(a)).toBe(1);
  });

  it('파싱 불가한 형식은 400 대상으로 던진다', () => {
    expect(() => parseKstDateTime('어제')).toThrow(SettleTimeParseError);
  });
});

describe('월 경계 (§6.7)', () => {
  const periodEnd = new Date(2026, 6, 1, 0, 0, 0, 0); // 7/1 00:00 KST

  it('periodEnd 는 exclusive 경계다', () => {
    expect(isBeforePeriodEnd(parseKstDateTime('2026-06-30 23:59:59.999999'), periodEnd)).toBe(true);
    expect(isBeforePeriodEnd(fromDate(periodEnd), periodEnd)).toBe(false);
    expect(isBeforePeriodEnd(parseKstDateTime('2026-07-01 00:00:00.000001'), periodEnd)).toBe(false);
  });

  it('occurredAt NULL 은 sweep 에서 자동 배제된다', () => {
    expect(isBeforePeriodEnd(null, periodEnd)).toBe(false);
  });

  it('월중·월초·월말 어느 시각이든 다음 달 1일을 기대 경계로 만든다 (32차 off-by-one)', () => {
    const cases = [
      new Date(2026, 4, 15, 12, 0, 0),
      new Date(2026, 4, 1, 0, 0, 0),
      new Date(2026, 4, 31, 23, 59, 59, 999),
    ];
    for (const from of cases) {
      const expected = nextMonthStartKst(startOfMonthKst(from));
      expect(expected.getFullYear()).toBe(2026);
      expect(expected.getMonth()).toBe(5); // 6월
      expect(expected.getDate()).toBe(1);
    }
  });
});
