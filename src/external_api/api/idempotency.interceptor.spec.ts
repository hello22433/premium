import { createHash } from 'crypto';

import { firstValueFrom, of, throwError } from 'rxjs';

import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyKeyStatus } from '../../entity/idempotency.key.entity';

// 멱등 계약(매핑 필수 모드) 회귀 가드:
//   신규 요청이 다운스트림에서 실패(예: require 모드 2001)하면 키 행을 제거해 에러를 캐시하지 않는다.
//   → 동일 키 재시도도 재처리되어 다시 2001 을 받는다(성공 응답 재생이 아님).
//   성공 시에는 COMPLETE 로 캐시한다.

const makeCtx = (req: any, res: any) =>
  ({ switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) }) as any;

const baseReq = (over: any = {}) => ({
  headers: { 'idempotency-key': 'k1' },
  apiContext: { apiApp: { id: '1' }, billingUserId: 42 },
  method: 'POST',
  route: { path: '/api/v1/external/orders' },
  path: '/api/v1/external/orders',
  body: { a: 1 },
  ...over,
});

describe('IdempotencyInterceptor 멱등 계약', () => {
  let repo: any;
  let interceptor: IdempotencyInterceptor;

  beforeEach(() => {
    repo = {
      findOne: jest.fn(async () => null),
      create: jest.fn((x: any) => x),
      save: jest.fn(async (x: any) => x),
      remove: jest.fn(async () => undefined),
    };
    interceptor = new IdempotencyInterceptor(repo);
  });

  it('신규 키 + 다운스트림 2001 → 키 행 제거 후 에러 전파(캐시 안 함 → 재시도 재처리)', async () => {
    const req = baseReq();
    const res = { statusCode: 200, status: jest.fn() };
    const err = Object.assign(new Error('externalCustomerId 필수'), { code: '2001' });
    const next = { handle: () => throwError(() => err) };

    const obs = await interceptor.intercept(makeCtx(req, res), next as any);
    await expect(firstValueFrom(obs)).rejects.toBe(err);

    // PROCESSING 행 저장 → 에러 시 remove 로 제거(에러 미캐시)
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'k1', status: IdempotencyKeyStatus.PROCESSING }),
    );
    expect(repo.remove).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'k1' }));
  });

  it('완료된 키 재요청 → 기존 응답/상태 재생(신규 처리 없음)', async () => {
    const cached = {
      idempotencyKey: 'k1',
      requestHash: undefined as unknown as string,
      status: IdempotencyKeyStatus.COMPLETE,
      responseStatus: 201,
      responseBody: { result: { code: '0000' } },
      expiresAt: new Date(Date.now() + 60_000),
    };
    // requestHash 는 body 로 계산되므로, 동일 body 로 매칭되도록 실제 해시로 맞춘다(재생 경로 검증).
    cached.requestHash = createHash('sha256')
      .update(JSON.stringify({ a: 1 }))
      .digest('hex');
    repo.findOne = jest.fn(async () => cached);

    const req = baseReq();
    const res = { statusCode: 200, status: jest.fn() };
    const next = { handle: jest.fn(() => of({ never: true })) };

    const obs = await interceptor.intercept(makeCtx(req, res), next as any);
    await expect(firstValueFrom(obs)).resolves.toEqual({ result: { code: '0000' } });

    // 재생 경로: 다운스트림 미호출, 신규 저장/제거 없음
    expect(next.handle).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.remove).not.toHaveBeenCalled();
  });
});
