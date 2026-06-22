/**
 * 회귀: 알림톡 inquiry 재시도 횟수·에러 메시지 일치 고정
 *
 * 검증 목표:
 *  - 모든 inquiry가 실패할 때 실제 호출 횟수 = INQUIRY_MAX_ATTEMPTS (현재 2)
 *  - 마지막 실패 로그에 `, retrying...` 미포함 (마지막 시도 인식)
 *  - throw 에러 메시지 내 횟수 = 실제 loop 횟수 (불일치 시 오해 유발)
 */

jest.mock('../../util/time.util', () => ({
  sleep: jest.fn().mockResolvedValue(undefined),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import { DeliveryAlimTalkInfoBankHttp } from './delivery.alim.talk.info.bank.http';

const makeHttpService = (overrides: Partial<HttpService> = {}) =>
  ({
    post: jest.fn(),
    get: jest.fn(),
    ...overrides,
  }) as unknown as HttpService;

const makeConfigService = () =>
  ({
    getOrThrow: jest.fn((key: string) => {
      const map: Record<string, string> = {
        ALIM_TALK_INFO_BANK_ID: 'id',
        ALIM_TALK_INFO_BANK_PASSWORD: 'pw',
        ALIM_TALK_INFO_BANK_SENDER_KEY: 'senderKey',
        ALIM_TALK_INFO_BANK_TEMPLATE_CODE: 'TMPL',
        ALIM_TALK_RECEIVE_URL: 'https://receive.test',
        ALIM_TALK_REPORT_URL: 'https://report.test',
        ALIM_TALK_API_KEY: 'apiKey',
        ENVIRONMENT: 'test',
      };
      return map[key] ?? '';
    }),
  }) as unknown as ConfigService;

describe('DeliveryAlimTalkInfoBankHttp — inquiry 재시도 횟수 일치', () => {
  let service: DeliveryAlimTalkInfoBankHttp;
  let httpService: HttpService;

  const authResponse = {
    data: {
      data: {
        schema: 'Bearer',
        token: 'tok',
        expired: new Date(Date.now() + 3600_000).toISOString(),
      },
    },
  };

  const sendResponse = {
    data: { code: 'A000', result: 'Success', msgKey: 'MK-001' },
  };

  beforeEach(async () => {
    httpService = makeHttpService();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveryAlimTalkInfoBankHttp,
        { provide: HttpService, useValue: httpService },
        { provide: ConfigService, useFactory: makeConfigService },
      ],
    }).compile();

    service = module.get(DeliveryAlimTalkInfoBankHttp);
  });

  it('inquiry 전부 실패 시 inquiryReport 호출 횟수 = INQUIRY_MAX_ATTEMPTS', async () => {
    (httpService.post as jest.Mock)
      .mockReturnValueOnce(of(authResponse))
      .mockReturnValueOnce(of(sendResponse));

    // inquiry 응답: 항상 404 에러
    (httpService.get as jest.Mock).mockReturnValue(
      throwError(() => ({ response: { data: { code: 'E404', result: 'Not Found' } } })),
    );

    await expect(
      service.send({ to: '01012345678', text: '테스트', templateCode: 'TMPL' }),
    ).rejects.toThrow();

    expect(httpService.get).toHaveBeenCalledTimes(2);
  });

  it('마지막 실패 로그에 retrying 없음, 중간 실패 로그에 retrying 있음', async () => {
    const logSpy = jest.spyOn((service as any).logger, 'log').mockImplementation(() => {});

    (httpService.post as jest.Mock)
      .mockReturnValueOnce(of(authResponse)) // getToken
      .mockReturnValueOnce(of(sendResponse)); // send

    (httpService.get as jest.Mock).mockReturnValue(
      throwError(() => ({ response: { data: { code: 'E404', result: 'Not Found' } } })),
    );

    await expect(
      service.send({ to: '01012345678', text: '테스트', templateCode: 'TMPL' }),
    ).rejects.toThrow();

    const failLogs = logSpy.mock.calls
      .map(([msg]) => msg as string)
      .filter((msg) => msg.startsWith('Report inquiry failed'));

    // INQUIRY_MAX_ATTEMPTS = 2 이므로 실패 로그 2건
    expect(failLogs).toHaveLength(2);

    // attempt 1 (중간): retrying 포함
    expect(failLogs[0]).toContain(', retrying...');

    // attempt 2 (마지막): retrying 미포함
    expect(failLogs[1]).not.toContain(', retrying...');
  });

  it('throw 에러 메시지 내 횟수가 실제 loop 횟수(2)와 일치', async () => {
    (httpService.post as jest.Mock)
      .mockReturnValueOnce(of(authResponse))
      .mockReturnValueOnce(of(sendResponse));

    (httpService.get as jest.Mock).mockReturnValue(
      throwError(() => ({ response: { data: { code: 'E404', result: 'Not Found' } } })),
    );

    await expect(
      service.send({ to: '01012345678', text: '테스트', templateCode: 'TMPL' }),
    ).rejects.toThrow(/inquiry failed after 2 attempts/);
  });
});
