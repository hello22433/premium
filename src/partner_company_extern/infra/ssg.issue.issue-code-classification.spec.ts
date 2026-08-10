import { of } from 'rxjs';
import { SsgIssue, SsgIssueRejectedError, SsgIssueUnknownError } from './ssg.issue';

/**
 * SSG INSERT(`SsgCoupon.do`) 응답 code 분류 검증.
 *
 * - `1000` = 성공 → 정상 반환
 * - `9999` = 중계↔Oracle 통신 실패(미확정) → `SsgIssueUnknownError`
 * - 그 외 non-1000 = 확정 거절 → `SsgIssueRejectedError`
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

  it('code 8021 → SsgIssueRejectedError (확정 거절)', async () => {
    const sut = buildSut({ get: jest.fn(() => xmlResponse('8021', '잔액 부족')) });

    await expect(sut.issue(issueParams)).rejects.toBeInstanceOf(SsgIssueRejectedError);
  });

  it('code 1001 → SsgIssueRejectedError (확정 거절)', async () => {
    const sut = buildSut({ get: jest.fn(() => xmlResponse('1001', '중복 요청')) });

    await expect(sut.issue(issueParams)).rejects.toBeInstanceOf(SsgIssueRejectedError);
  });

  it('code 파싱 불가 → SsgIssueUnknownError', async () => {
    const sut = buildSut({ get: jest.fn(() => of({ data: '<response><result></result></response>' } as any)) });

    await expect(sut.issue(issueParams)).rejects.toBeInstanceOf(SsgIssueUnknownError);
  });
});
