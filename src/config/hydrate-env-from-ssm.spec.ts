// SSM SDK를 가짜(mock)로 바꿔서, 실제 AWS 호출 없이 로더 동작만 검증한다.
const sendMock = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: sendMock })),
  GetParametersByPathCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

import { hydrateEnvFromSsm } from './hydrate-env-from-ssm';

describe('hydrateEnvFromSsm', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('ENVIRONMENT 미설정이면 SSM을 호출하지 않는다 — 무영향', async () => {
    delete process.env.ENVIRONMENT;
    delete process.env.SSM_PARAM_PATH;
    await hydrateEnvFromSsm();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('ENVIRONMENT=dev면 /epopkon-premium/dev/ 경로로 자동 동작한다', async () => {
    process.env.ENVIRONMENT = 'dev';
    delete process.env.SSM_PARAM_PATH;
    delete process.env.DATABASE_PASSWORD;
    sendMock.mockResolvedValueOnce({
      Parameters: [{ Name: '/epopkon-premium/dev/DATABASE_PASSWORD', Value: 'dev-secret' }],
      NextToken: undefined,
    });

    await hydrateEnvFromSsm();

    expect(sendMock.mock.calls[0][0].input.Path).toBe('/epopkon-premium/dev/');
    expect(process.env.DATABASE_PASSWORD).toBe('dev-secret');
  });

  it('ENVIRONMENT=local이면 /epopkon-premium/local/ 경로로 자동 동작한다', async () => {
    process.env.ENVIRONMENT = 'local';
    delete process.env.SSM_PARAM_PATH;
    sendMock.mockResolvedValueOnce({ Parameters: [], NextToken: undefined });

    await hydrateEnvFromSsm();

    expect(sendMock.mock.calls[0][0].input.Path).toBe('/epopkon-premium/local/');
  });

  it('SSM_PARAM_PATH를 주면 그 경로로 override한다(스테이징 등)', async () => {
    process.env.ENVIRONMENT = 'dev';
    process.env.SSM_PARAM_PATH = '/epopkon-premium/staging/';
    sendMock.mockResolvedValueOnce({ Parameters: [], NextToken: undefined });

    await hydrateEnvFromSsm();

    expect(sendMock.mock.calls[0][0].input.Path).toBe('/epopkon-premium/staging/');
  });

  it('SSM_PARAM_PATH에 끝 슬래시가 없어도 키 이름을 올바르게 추출한다', async () => {
    process.env.ENVIRONMENT = 'dev';
    process.env.SSM_PARAM_PATH = '/epopkon-premium/staging'; // 끝 슬래시 없음
    delete process.env.DATABASE_PASSWORD;
    sendMock.mockResolvedValueOnce({
      Parameters: [{ Name: '/epopkon-premium/staging/DATABASE_PASSWORD', Value: 'x' }],
      NextToken: undefined,
    });

    await hydrateEnvFromSsm();

    // '/DATABASE_PASSWORD'(앞 슬래시)가 아니라 'DATABASE_PASSWORD'로 들어가야 함
    expect(process.env.DATABASE_PASSWORD).toBe('x');
    expect(process.env['/DATABASE_PASSWORD']).toBeUndefined();
  });

  it('NextToken으로 여러 페이지를 모두 읽는다(페이지네이션)', async () => {
    process.env.ENVIRONMENT = 'prod';
    delete process.env.SSM_PARAM_PATH;
    delete process.env.KEY_A;
    delete process.env.KEY_B;
    sendMock
      .mockResolvedValueOnce({
        Parameters: [{ Name: '/epopkon-premium/prod/KEY_A', Value: 'a' }],
        NextToken: 'page2',
      })
      .mockResolvedValueOnce({
        Parameters: [{ Name: '/epopkon-premium/prod/KEY_B', Value: 'b' }],
        NextToken: undefined,
      });

    await hydrateEnvFromSsm();

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[1][0].input.NextToken).toBe('page2'); // 2번째 호출에 토큰 전달
    expect(process.env.KEY_A).toBe('a');
    expect(process.env.KEY_B).toBe('b');
  });

  it('운영에서 파라미터를 process.env에 주입한다', async () => {
    process.env.ENVIRONMENT = 'prod';
    process.env.SSM_PARAM_PATH = '/epopkon-premium/prod/';
    delete process.env.DATABASE_PASSWORD;
    sendMock.mockResolvedValueOnce({
      Parameters: [{ Name: '/epopkon-premium/prod/DATABASE_PASSWORD', Value: 'secret123' }],
      NextToken: undefined,
    });

    await hydrateEnvFromSsm();

    expect(process.env.DATABASE_PASSWORD).toBe('secret123');
  });

  it('이미 존재하는 env 값은 덮어쓰지 않는다(부트스트랩/오버라이드 우선)', async () => {
    process.env.ENVIRONMENT = 'prod';
    process.env.SSM_PARAM_PATH = '/epopkon-premium/prod/';
    process.env.DATABASE_PASSWORD = 'from-env';
    sendMock.mockResolvedValueOnce({
      Parameters: [{ Name: '/epopkon-premium/prod/DATABASE_PASSWORD', Value: 'from-ssm' }],
    });

    await hydrateEnvFromSsm();

    expect(process.env.DATABASE_PASSWORD).toBe('from-env');
  });

  it('SSM 호출이 실패해도 throw 하지 않는다(페일세이프)', async () => {
    process.env.ENVIRONMENT = 'prod';
    sendMock.mockRejectedValueOnce(new Error('access denied'));

    await expect(hydrateEnvFromSsm()).resolves.toBeUndefined();
  });
});
