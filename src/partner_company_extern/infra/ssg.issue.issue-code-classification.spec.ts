import { of } from 'rxjs';
import { SsgIssue, SsgIssueUnknownError } from './ssg.issue';

/**
 * SSG INSERT(`SsgCoupon.do`) 응답 code 분류 검증.
 *
 * - `1000` = 성공 → 정상 반환
 * - `9999` = 중계↔Oracle 통신 실패(미확정) → `SsgIssueUnknownError`
 * - all other codes have no documented rejection contract → `SsgIssueUnknownError`
 * - code 파싱 불가 → `SsgIssueUnknownError`
 *
 * 실측: 9999 후 수동 재발송 성공률 100% — 일시적 오류. EP_P21 참조.
 */
describe('SsgIssue.issue — 응답 code 분류', () => {
  const issueParams = {
    eventNo: 'EV1',
    eventSeq: 1,
    eventKey: 'EK1',
    vno: '01312345678',
    pinNo: '80000001',
    userName: '테스트',
    userAmount: '5000',
    msgContent: '쿠폰입니다',
    trId: 'TR-001',
    callBack: '0200000000',
  };

  const buildSut = (httpService: any): SsgIssue =>
    new SsgIssue(httpService, { getOrThrow: () => 'https://ssg.example', get: () => 'https://ssg.example' } as any);

  const xmlResponse = (code: string, reason: string) =>
    of({
      data: `<response><result><code>${code}</code><reason>${reason}</reason></result></response>`,
    } as any);

  it('code 1000 → 정상 반환 (성공)', async () => {
    const sut = buildSut({ get: jest.fn(() => xmlResponse('1000', 'ok')) });

    const result = await sut.issue(issueParams);

    expect(result?.response?.result?.[0]?.code?.[0]).toBe('1000');
  });

  it('code 9999 → SsgIssueUnknownError (미확정, 거절 아님)', async () => {
    const sut = buildSut({ get: jest.fn(() => xmlResponse('9999', '알 수 없는 오류입니다.')) });

    await expect(sut.issue(issueParams)).rejects.toBeInstanceOf(SsgIssueUnknownError);
  });

  it('code 9999 → reason 보존', async () => {
    const sut = buildSut({ get: jest.fn(() => xmlResponse('9999', '알 수 없는 오류입니다.')) });

    await expect(sut.issue(issueParams)).rejects.toThrow('알 수 없는 오류입니다.');
  });

  it.each(['8021', '1001'])('code %s → SsgIssueUnknownError (official rejection allowlist 없음)', async (code) => {
    const sut = buildSut({ get: jest.fn(() => xmlResponse(code, '미확정')) });

    await expect(sut.issue(issueParams)).rejects.toBeInstanceOf(SsgIssueUnknownError);
  });

  it('code 파싱 불가 → SsgIssueUnknownError', async () => {
    const sut = buildSut({ get: jest.fn(() => of({ data: '<response><result></result></response>' } as any)) });

    await expect(sut.issue(issueParams)).rejects.toBeInstanceOf(SsgIssueUnknownError);
  });
  it.each(['9999', '0103', '8021'])('GetSsgStatus code %s → SsgIssueUnknownError', async (code) => {
    const sut = buildSut({ get: jest.fn(() => xmlResponse(code, '미확정')) });

    await expect(sut.check({ eventNo: 'EV1', eventSeq: 1, vno: '01312345678' })).rejects.toBeInstanceOf(
      SsgIssueUnknownError,
    );
  });

  it('GetSsgStatus missing code → SsgIssueUnknownError', async () => {
    const sut = buildSut({ get: jest.fn(() => of({ data: '<response><result></result></response>' } as any)) });

    await expect(sut.check({ eventNo: 'EV1', eventSeq: 1, vno: '01312345678' })).rejects.toBeInstanceOf(
      SsgIssueUnknownError,
    );
  });
});
