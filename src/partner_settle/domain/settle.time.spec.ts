import {
  isBeforePeriodEnd,
  nextMonthStartKst,
  parseCompactDateTime,
  parseDayAndTime,
  parseDayOnly,
  parseKstDateTime,
  SettleTimeParseError,
  startOfMonthKst,
} from './settle.time';

describe('원천 시각 파싱 — 정밀도 보존', () => {
  it('갤럭시아 appDay+appTime 은 초 정밀도로 읽는다', () => {
    const parsed = parseDayAndTime('20260630', '235959');
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(5);
    expect(parsed.getDate()).toBe(30);
    expect(parsed.getHours()).toBe(23);
    expect(parsed.getSeconds()).toBe(59);
    expect(parsed.getMilliseconds()).toBe(0);
  });

  it('케이티알파 exchDtm(YYYYMMDDHHmmss) 을 읽는다', () => {
    const parsed = parseCompactDateTime('20260701000000');
    expect(parsed.getMonth()).toBe(6);
    expect(parsed.getDate()).toBe(1);
    expect(parsed.getHours()).toBe(0);
  });

  it('일 단위 원천은 그 날 00:00:00 으로 고정한다 (임의 시각 부여 금지)', () => {
    for (const raw of ['20260706', '2026-07-06']) {
      const parsed = parseDayOnly(raw);
      expect(parsed.getDate()).toBe(6);
      expect(parsed.getHours()).toBe(0);
      expect(parsed.getMinutes()).toBe(0);
      expect(parsed.getSeconds()).toBe(0);
      expect(parsed.getMilliseconds()).toBe(0);
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
  it('같은 시각의 +09:00 ISO 와 KST naive 는 동일 시각으로 정규화된다', () => {
    const naive = parseKstDateTime('2026-07-06 13:24:35');
    const offset = parseKstDateTime('2026-07-06T13:24:35+09:00');
    expect(offset.getTime()).toBe(naive.getTime());
  });

  it('마이크로초는 6자리까지 허용하고 7자리 이상은 거부한다', () => {
    expect(parseKstDateTime('2026-07-06 13:24:35.123456').getMilliseconds()).toBe(123);
    expect(() => parseKstDateTime('2026-07-06 13:24:35.1234567')).toThrow(SettleTimeParseError);
  });
});

describe('월 경계 (§6.7)', () => {
  it('periodEnd 는 exclusive 경계다', () => {
    const periodEnd = new Date(2026, 6, 1, 0, 0, 0, 0); // 7/1 00:00 KST
    expect(isBeforePeriodEnd(new Date(2026, 5, 30, 23, 59, 59, 999), periodEnd)).toBe(true);
    expect(isBeforePeriodEnd(periodEnd, periodEnd)).toBe(false);
    expect(isBeforePeriodEnd(new Date(2026, 6, 1, 0, 0, 0, 1), periodEnd)).toBe(false);
  });

  it('occurredAt NULL 은 sweep 에서 자동 배제된다', () => {
    expect(isBeforePeriodEnd(null, new Date(2026, 6, 1))).toBe(false);
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
