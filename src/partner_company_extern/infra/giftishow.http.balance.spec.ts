import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import { GiftishowHttp } from './giftishow.http';

describe('GiftishowHttp.getCompanyBalance (0305)', () => {
  const get = jest.fn();
  const httpService = { get } as unknown as HttpService;
  const configService = {
    getOrThrow: (key: string) => {
      const values: Record<string, string> = {
        GIFTI_SHOW_CORP_CODE: 'CORP',
        GIFTI_SHOW_CUSTOM_AUTH_TOKEN: 'TOKEN',
        ENVIRONMENT: 'dev',
      };
      return values[key];
    },
  } as unknown as ConfigService;

  let sut: GiftishowHttp;

  beforeEach(() => {
    get.mockReset();
    sut = new GiftishowHttp(httpService, configService);
  });

  it('정상 응답이면 한도/사용가능금액을 반환한다', async () => {
    get.mockReturnValue(
      of({
        data: {
          resCode: '0000',
          resMsg: '정상처리',
          pointCompanyBalance: { loanLimit: '5000000', usePosblAmt: '1234000' },
        },
      }),
    );

    const result = await sut.getCompanyBalance();

    expect(result).toEqual({
      resCode: '0000',
      resMsg: '정상처리',
      pointCompanyBalance: { loanLimit: '5000000', usePosblAmt: '1234000' },
    });

    const [url, options] = get.mock.calls[0];
    expect(url).toBe('http://tgiftishowgw.giftishow.co.kr/points/company/balance');
    expect(options.headers).toEqual({
      api_code: '0305',
      custom_auth_code: 'CORP',
      custom_auth_token: 'TOKEN',
      custom_enc_flag: 'N',
      Accept: 'application/json',
    });
  });

  it('에러 코드 응답이면 잔액 없이 코드/메시지를 그대로 반환한다', async () => {
    get.mockReturnValue(of({ data: { resCode: '9999', resMsg: '인증실패' } }));

    const result = await sut.getCompanyBalance();

    expect(result).toEqual({ resCode: '9999', resMsg: '인증실패', pointCompanyBalance: undefined });
  });

  it('네트워크 에러는 그대로 throw 한다', async () => {
    get.mockReturnValue(throwError(() => new Error('ETIMEDOUT')));

    await expect(sut.getCompanyBalance()).rejects.toThrow('ETIMEDOUT');
  });
});
