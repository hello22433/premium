import { of, throwError } from 'rxjs';
import { SsgIssue, SsgTryError } from './ssg.issue';

/**
 * `GetSsgTry.do` 실패의 **타입 통일** 검증.
 *
 * 종전에는 응답 이상(`tryYn` 없음)만 `SsgTryError` 였고 네트워크·파싱 실패는 raw 에러가 그대로
 * 새어나갔다. 두 경우 모두 의미는 같다 — **제출 여부 판정 불가**. 호출자(발송 배치 2-pass)가
 * 하나의 타입만 보고 보류를 판단할 수 있어야 하므로 `SsgTryError` 로 통일한다
 * (`plans/2026-08-03-pin-issue-retry-wiring.md` §4.2).
 *
 * ⚠ 이 에러는 "발급 안 됨" 이 아니라 "알 수 없음" 이다. 호출자는 이 타입을 근거로 새 PIN 을
 * 발급하면 안 되고, 재조회만 해야 한다.
 */
describe('SsgIssue.getTry — 조회 실패 타입 통일', () => {
  const buildSut = (httpService: any): SsgIssue =>
    new SsgIssue(httpService, { getOrThrow: () => 'https://ssg.example', get: () => 'https://ssg.example' } as any);

  const xml = (body: string) => of({ data: body } as any);

  it('네트워크 오류 → SsgTryError 로 감싼다 (종전에는 raw 에러가 새어나갔다)', async () => {
    const sut = buildSut({ get: jest.fn(() => throwError(() => new Error('ECONNRESET'))) });

    await expect(sut.getTry({ vno: '01312345678' })).rejects.toBeInstanceOf(SsgTryError);
  });

  it('네트워크 오류 원문을 메시지에 보존한다 (운영 원인 추적)', async () => {
    const sut = buildSut({ get: jest.fn(() => throwError(() => new Error('ECONNRESET'))) });

    await expect(sut.getTry({ vno: '01312345678' })).rejects.toThrow(/ECONNRESET/);
  });

  it('파싱 실패(XML 아님) → SsgTryError', async () => {
    const sut = buildSut({ get: jest.fn(() => xml('<<<not xml')) });

    await expect(sut.getTry({ vno: '01312345678' })).rejects.toBeInstanceOf(SsgTryError);
  });

  it('SSG 가 준 reason 을 그대로 노출한다 — 상용 사고 문구', async () => {
    const sut = buildSut({
      get: jest.fn(() =>
        xml('<response><result><code>9999</code><reason>알 수 없는 오류입니다.</reason></result></response>'),
      ),
    });

    await expect(sut.getTry({ vno: '01312345678' })).rejects.toThrow('알 수 없는 오류입니다.');
  });

  it('tryYn=N 정상 응답은 throw 하지 않는다 — 조회 성공은 재시도 대상이 아니다', async () => {
    const sut = buildSut({
      get: jest.fn(() => xml('<response><value><vno>x</vno><tryYn>N</tryYn></value></response>')),
    });

    const out = await sut.getTry({ vno: '01312345678' });
    expect(out?.response?.value?.[0]?.tryYn?.[0]).toBe('N');
  });
});
