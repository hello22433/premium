import { of, throwError } from 'rxjs';
import { AxiosError } from 'axios';
import { DepositSourceHttp } from './deposit.source.http';
import { DepositSourcePermanentError, DepositSourceTransientError } from '../interface/deposit.source';

/**
 * 상대 API 와의 **계약 접점** 회귀 테스트.
 *
 * 이 파일이 없어서 실제로 사고가 하나 살아남았다 — 정렬 파라미터를 배열로 넘겼더니 axios 가
 * `sort[]=…` 로 직렬화했고, Spring 은 `sort` 만 읽으므로 조용히 무시됐다. 코드에는 "오름차순을
 * 강제해 페이지 순회 누락을 막는다"는 긴 주석이 달려 있었지만 그 방어는 한 번도 작동하지 않았다.
 * 그래서 여기서는 **와이어에 실제로 실리는 문자열**을 검증한다.
 */
describe('DepositSourceHttp', () => {
  const buildSut = (config: Record<string, string> = {}) => {
    const requests: { url: string; options: any }[] = [];
    const httpService: any = {
      get: jest.fn((url: string, options: any) => {
        requests.push({ url, options });
        return of({
          data: { content: [], totalElements: 0, totalPages: 0, number: 0, size: 500 },
        });
      }),
    };
    const configService: any = {
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, string> = {
          ERP_MACRO_API_BASE_URL: 'https://erp.example.com',
          ERP_MACRO_API_KEY: 'secret-key',
          ...config,
        };
        return key in values ? values[key] : fallback;
      }),
    };
    return { sut: new DepositSourceHttp(httpService, configService), requests, httpService };
  };

  /** axios 에 넘긴 params 를 실제 쿼리스트링으로 환산한다. */
  const queryString = (options: any) => String(new URLSearchParams(options.params as any));

  describe('쿼리스트링 직렬화', () => {
    it('정렬을 같은 키 반복(sort=…&sort=…)으로 보낸다 — sort[] 로 나가면 Spring 이 무시한다', async () => {
      const { sut, requests } = buildSut();

      await sut.fetchPage('2026-07-01', '2026-07-31', 0, 500);

      const qs = queryString(requests[0].options);
      expect(qs).toContain('sort=txDate%2Casc');
      expect(qs).toContain('sort=id%2Casc');
      expect(qs).not.toContain('sort%5B%5D'); // sort[]
    });

    it('기간·페이지·크기를 그대로 싣는다', async () => {
      const { sut, requests } = buildSut();

      await sut.fetchPage('2026-07-01', '2026-07-31', 3, 200);

      const qs = queryString(requests[0].options);
      expect(qs).toContain('from=2026-07-01');
      expect(qs).toContain('to=2026-07-31');
      expect(qs).toContain('page=3');
      expect(qs).toContain('size=200');
    });

    it('base URL 뒤 슬래시가 있어도 경로가 //deposits 가 되지 않는다', async () => {
      const { sut, requests } = buildSut({ ERP_MACRO_API_BASE_URL: 'https://erp.example.com/' });

      await sut.fetchPage('2026-07-01', '2026-07-31', 0, 500);

      expect(requests[0].url).toBe('https://erp.example.com/api/deposits');
    });

    it('인증 헤더를 싣는다', async () => {
      const { sut, requests } = buildSut();

      await sut.fetchPage('2026-07-01', '2026-07-31', 0, 500);

      expect(requests[0].options.headers).toEqual({ 'X-API-KEY': 'secret-key' });
    });
  });

  describe('타임아웃', () => {
    it('설정이 없으면 기본 30초', async () => {
      const { sut, requests } = buildSut();

      await sut.fetchPage('2026-07-01', '2026-07-31', 0, 500);

      expect(requests[0].options.timeout).toBe(30_000);
    });

    // NaN 을 그대로 넘기면 axios 의 `if (config.timeout)` 이 거짓이 되어 타임아웃이 사라진다.
    it.each(['', 'abc', '0', '-1'])('설정이 이상한 값(%s)이면 기본값으로 되돌린다', async (raw) => {
      const { sut, requests } = buildSut({ ERP_MACRO_API_TIMEOUT_MS: raw });

      await sut.fetchPage('2026-07-01', '2026-07-31', 0, 500);

      expect(requests[0].options.timeout).toBe(30_000);
    });

    it('상태 조회는 화면 경로라 더 짧게 끊는다', async () => {
      const { sut, httpService, requests } = buildSut();
      httpService.get.mockImplementationOnce((url: string, options: any) => {
        requests.push({ url, options });
        return of({ data: { lastScrapedAt: null, gateTripped: false, gateReason: null } });
      });

      await sut.fetchStatus();

      expect(requests[0].options.timeout).toBe(3_000);
    });
  });

  describe('설정 누락', () => {
    it.each(['ERP_MACRO_API_BASE_URL', 'ERP_MACRO_API_KEY'])('%s 가 비면 영구 실패로 끊는다', async (key) => {
      const { sut } = buildSut({ [key]: '' });

      await expect(sut.fetchPage('2026-07-01', '2026-07-31', 0, 500)).rejects.toBeInstanceOf(
        DepositSourcePermanentError,
      );
    });
  });

  describe('실패 분류', () => {
    const withError = (error: unknown) => {
      const { sut, httpService } = buildSut();
      httpService.get.mockReturnValue(throwError(() => error));
      return sut;
    };

    const axiosErrorWith = (status: number) => ({ response: { status } }) as AxiosError;

    it.each([401, 403])('인증 실패(%s)는 재시도해도 소용없으므로 영구 실패', async (status) => {
      await expect(withError(axiosErrorWith(status)).fetchPage('a', 'b', 0, 1)).rejects.toBeInstanceOf(
        DepositSourcePermanentError,
      );
    });

    it.each([400, 404])('요청 거부(%s)는 계약 불일치이므로 영구 실패', async (status) => {
      await expect(withError(axiosErrorWith(status)).fetchPage('a', 'b', 0, 1)).rejects.toBeInstanceOf(
        DepositSourcePermanentError,
      );
    });

    it.each([500, 502, 503])('서버 오류(%s)는 다음 주기에 재시도하면 되므로 일시 실패', async (status) => {
      await expect(withError(axiosErrorWith(status)).fetchPage('a', 'b', 0, 1)).rejects.toBeInstanceOf(
        DepositSourceTransientError,
      );
    });

    it('네트워크 오류(응답 없음)는 일시 실패', async () => {
      await expect(
        withError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' } as AxiosError).fetchPage('a', 'b', 0, 1),
      ).rejects.toBeInstanceOf(DepositSourceTransientError);
    });
  });

  describe('응답 형태 검증', () => {
    const withData = (data: unknown) => {
      const { sut, httpService } = buildSut();
      httpService.get.mockReturnValue(of({ data }));
      return sut;
    };

    it.each([
      ['빈 응답', null],
      ['content 없음', { totalElements: 0 }],
      ['content 가 배열이 아님', { content: 'oops', totalElements: 0 }],
      ['totalElements 없음', { content: [] }],
      ['HTML 오류 페이지', '<html>502</html>'],
    ])('목록 응답이 계약과 다르면 일시 실패로 끊는다 (%s)', async (_label, data) => {
      await expect(withData(data).fetchPage('a', 'b', 0, 1)).rejects.toBeInstanceOf(DepositSourceTransientError);
    });

    it('정상 목록 응답은 그대로 통과한다', async () => {
      const page = { content: [{ dedupKey: 'a' }], totalElements: 1, totalPages: 1, number: 0, size: 1 };

      await expect(withData(page).fetchPage('a', 'b', 0, 1)).resolves.toEqual(page);
    });

    // gateTripped 가 undefined 면 "차단 안 됨"으로 보이지만 실제로는 "모름"이다. 가장 나쁜 값이다.
    it.each([
      ['빈 응답', null],
      ['gateTripped 없음', { lastScrapedAt: null }],
      ['HTML 오류 페이지', '<html>502</html>'],
    ])('상태 응답이 계약과 다르면 일시 실패로 끊는다 (%s)', async (_label, data) => {
      await expect(withData(data).fetchStatus()).rejects.toBeInstanceOf(DepositSourceTransientError);
    });

    it('정상 상태 응답은 그대로 통과한다', async () => {
      const status = { lastScrapedAt: null, gateTripped: true, gateReason: '기기 재등록 필요' };

      await expect(withData(status).fetchStatus()).resolves.toEqual(status);
    });
  });
});
