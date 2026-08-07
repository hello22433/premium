import { SettleService } from './settle.service';
import { IReportSource } from '../../order/interface/report.source';

/**
 * 정산 목록의 발행 상태 문구 (settle.service.formatReportStatus).
 *
 * deliveryReportStatus / transactionStatementStatus 두 컬럼이 같은 함수를 공유한다.
 * 이메일 전송(EMAIL)도 DIRECT 와 동일하게 "발행"으로 본다 — 실무 확인 규칙.
 * 어느 경로였는지는 GET /order/:orderId/report-history 로 구분한다.
 *
 * ⚠️ 여기 문자열은 프론트가 그대로 렌더하는 사용자 노출 값이다. 값을 바꾸면 화면이 바뀐다.
 */

const format = (count: number, source: string | null): string =>
  (SettleService.prototype as any).formatReportStatus.call(null, count, source);

describe('formatReportStatus — 미발행', () => {
  it.each([
    ['DIRECT', IReportSource.DIRECT],
    ['EMAIL', IReportSource.EMAIL],
    ['DOCUMENT', IReportSource.DOCUMENT],
    ['null(레거시)', null],
  ])('count=0 이면 source 가 %s 여도 "-" 다 (카운트가 우선한다)', (_label, source) => {
    expect(format(0, source as string | null)).toBe('-');
  });
});

describe('formatReportStatus — 발행으로 보는 소스 (DIRECT / EMAIL)', () => {
  it('DIRECT 1회 → "발행 완료"', () => {
    expect(format(1, IReportSource.DIRECT)).toBe('발행 완료');
  });

  it('EMAIL 1회 → "발행 완료" (이메일 전송도 발행으로 집계)', () => {
    expect(format(1, IReportSource.EMAIL)).toBe('발행 완료');
  });

  it('DIRECT 2회 → "발행(재)"', () => {
    expect(format(2, IReportSource.DIRECT)).toBe('발행(재)');
  });

  it('EMAIL 2회 → "발행(재)"', () => {
    expect(format(2, IReportSource.EMAIL)).toBe('발행(재)');
  });

  it('EMAIL 3회 이상도 "발행(재)" 로 유지된다', () => {
    expect(format(5, IReportSource.EMAIL)).toBe('발행(재)');
  });
});

describe('formatReportStatus — 다운로드로 보는 소스', () => {
  it('DOCUMENT 1회 → "다운로드 완료"', () => {
    expect(format(1, IReportSource.DOCUMENT)).toBe('다운로드 완료');
  });

  it('DOCUMENT 2회 → "다운로드(재)"', () => {
    expect(format(2, IReportSource.DOCUMENT)).toBe('다운로드(재)');
  });

  it('source 가 null 인 레거시 행은 "다운로드 완료" 로 폴백한다', () => {
    expect(format(1, null)).toBe('다운로드 완료');
  });

  it('알 수 없는 source 값도 "다운로드" 계열로 폴백한다 (허용 목록 방식)', () => {
    expect(format(1, 'SOMETHING_NEW')).toBe('다운로드 완료');
  });
});

describe('formatReportStatus — 회귀 방지', () => {
  it('EMAIL 이 "다운로드 완료" 로 표시되지 않는다 (수정 전 동작)', () => {
    expect(format(1, IReportSource.EMAIL)).not.toBe('다운로드 완료');
  });

  it('DIRECT 기존 동작이 그대로 보존된다', () => {
    expect(format(1, 'DIRECT')).toBe('발행 완료');
    expect(format(2, 'DIRECT')).toBe('발행(재)');
  });
});
