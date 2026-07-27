import { classifyGemtekResult, GemtekResultOutcome } from './gemtek.result.policy';
import { advanceCursor, monthsToSearch, nextYearMonth, toYearMonth } from './result.partition.cursor';
import {
  computeNextAttemptAt,
  computeResendDeadline,
  isWithinAllowedSendWindow,
  isWithinResendDeadline,
} from './resend.schedule';

/**
 * §4 Gemtek 결과 코드 정책 / §7.2 재발송 시간 정책 / §7.3 증분 탐색.
 */
describe('Gemtek 결과 판정 (§4)', () => {
  it('최종 성공은 (STAT=3, RESULT=0) 조합뿐이다', () => {
    expect(classifyGemtekResult({ stat: '3', result: '0' })).toBe(GemtekResultOutcome.SUCCEEDED);
  });

  it('STAT 이 3 이 아니면 RESULT 가 0 이어도 확정 전이다(성공 추정 금지)', () => {
    expect(classifyGemtekResult({ stat: '2', result: '0' })).toBe(GemtekResultOutcome.UNKNOWN);
    expect(classifyGemtekResult({ stat: null, result: null })).toBe(GemtekResultOutcome.UNKNOWN);
    expect(classifyGemtekResult({ stat: '3', result: null })).toBe(GemtekResultOutcome.UNKNOWN);
  });

  it('504(expired)는 재발송 가능 실패로 분리한다', () => {
    expect(classifyGemtekResult({ stat: '3', result: '504' })).toBe(GemtekResultOutcome.RETRYABLE_504);
  });

  it('520·505·503·203 은 자동 재발송 금지 확정 실패다', () => {
    for (const result of ['520', '505', '503', '203']) {
      expect(classifyGemtekResult({ stat: '3', result })).toBe(GemtekResultOutcome.FAILED_FINAL);
    }
  });

  it('519(이통사 기타)와 미분류 코드는 실패로 단정하지 않고 UNKNOWN 으로 남긴다', () => {
    expect(classifyGemtekResult({ stat: '3', result: '519' })).toBe(GemtekResultOutcome.UNKNOWN);
    expect(classifyGemtekResult({ stat: '3', result: '9999' })).toBe(GemtekResultOutcome.UNKNOWN);
  });
});

describe('결과 파티션 증분 탐색 (§7.3)', () => {
  it('접수월부터 현재월까지만 조회하고 미래월은 보지 않는다', () => {
    expect(monthsToSearch('202606', '202608')).toEqual(['202606', '202607', '202608']);
    expect(monthsToSearch('202609', '202608')).toEqual([]);
  });

  it('연말 롤오버를 넘어간다', () => {
    expect(nextYearMonth('202612')).toBe('202701');
    expect(monthsToSearch('202611', '202701')).toEqual(['202611', '202612', '202701']);
  });

  it('미확정이면 다음 시작월을 현재월로 당겨 닫힌 과거월을 다시 훑지 않는다', () => {
    expect(advanceCursor('202607')).toEqual({ lastSearchedMonth: '202607', nextSearchMonth: '202607' });
  });

  it('월 롤오버 시 직전월을 한 번 더 훑는다(마감 직전 유입 누락 방지)', () => {
    const cursor = advanceCursor('202607');
    expect(monthsToSearch(cursor.nextSearchMonth, '202608')).toEqual(['202607', '202608']);
  });

  it('yyyyMM 형식이 아니면 조회 대상이 없다(동적 테이블명 주입 차단)', () => {
    expect(monthsToSearch("2026'; DROP TABLE", '202607')).toEqual([]);
    expect(toYearMonth(new Date('2026-07-05T10:00:00'))).toBe('202607');
  });
});

describe('504 재발송 시간 정책 (§7.2)', () => {
  it('허용 시간대(08:00–20:00) 확정은 즉시 예약한다', () => {
    const confirmed = new Date('2026-07-27T10:30:00');
    expect(computeNextAttemptAt(confirmed).getTime()).toBe(confirmed.getTime());
  });

  it('20:00 이후 확정은 익일 08:00 으로 미룬다(자동 발송 허용 시간대 08:00–20:00)', () => {
    expect(computeNextAttemptAt(new Date('2026-07-27T20:00:00')).toISOString()).toBe(
      new Date('2026-07-28T08:00:00').toISOString(),
    );
    expect(computeNextAttemptAt(new Date('2026-07-27T22:10:00')).toISOString()).toBe(
      new Date('2026-07-28T08:00:00').toISOString(),
    );
  });

  it('허용 시간대 판정은 08:00 포함 ~ 20:00 미포함이다', () => {
    expect(isWithinAllowedSendWindow(new Date('2026-07-27T07:59:59'))).toBe(false);
    expect(isWithinAllowedSendWindow(new Date('2026-07-27T08:00:00'))).toBe(true);
    expect(isWithinAllowedSendWindow(new Date('2026-07-27T19:59:59'))).toBe(true);
    expect(isWithinAllowedSendWindow(new Date('2026-07-27T20:00:00'))).toBe(false);
    expect(isWithinAllowedSendWindow(new Date('2026-07-27T01:01:00'))).toBe(false);
  });

  it('새벽(08:00 이전) 확정은 당일 08:00 으로 미룬다', () => {
    const next = computeNextAttemptAt(new Date('2026-07-27T03:00:00'));
    expect(next.toISOString()).toBe(new Date('2026-07-27T08:00:00').toISOString());
  });

  it('기한은 504 확정 시각 + 24h 이며 실행 시점으로 판정한다', () => {
    const confirmed = new Date('2026-07-27T10:00:00');
    expect(computeResendDeadline(confirmed).toISOString()).toBe(new Date('2026-07-28T10:00:00').toISOString());
    expect(isWithinResendDeadline(confirmed, new Date('2026-07-28T09:59:00'))).toBe(true);
    expect(isWithinResendDeadline(confirmed, new Date('2026-07-28T10:00:01'))).toBe(false);
  });
});
