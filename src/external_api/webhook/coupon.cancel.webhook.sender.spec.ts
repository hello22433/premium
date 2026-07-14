import { of } from 'rxjs';

// randomUUID 는 결정적으로 고정하되 createHmac 은 실제 구현을 사용한다.
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return { ...actual, randomUUID: jest.fn() };
});

import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';

import { CouponCancelWebhookSender } from './coupon.cancel.webhook.sender';

/**
 * 서명 계약 검증(발신 측).
 *
 * 기대 hex 는 sender 구현과 독립된 외부 오라클(openssl)로 사전 산출한 고정 상수다.
 * 도출 명령(재현 가능):
 *   printf '%s' "1700000000.{body}" | openssl dgst -sha256 -hmac "test-secret-123" -r
 * 수신 검증기(WebhookSignatureVerifier.computeHmacHex)는 private 이며 그 로직을 TS 로
 * 재구현해 비교하면 순환검증이 되므로 금지한다. 외부 오라클(openssl) 산출값만 사용한다.
 * 계약 출처: template WebhookSignatureVerifier/WebhookHmacFilter (X-Webhook-Signature: v1=<hex>,
 * X-Webhook-Timestamp: <unix epoch seconds>, 서명 대상 = "{ts}.{rawBody}", HmacSHA256, key=UTF-8).
 */
describe('CouponCancelWebhookSender HMAC signing', () => {
  const SECRET = 'test-secret-123';
  const FIXED_TS_SEC = 1700000000;
  const FIXED_TS_MS = FIXED_TS_SEC * 1000;
  const CANCELLED_AT = new Date('2026-05-11T12:00:00.000Z');

  // openssl 오라클 고정 벡터
  const EVENT_ID_V1 = '11111111-1111-4111-8111-111111111111';
  const EXPECTED_SIG_V1 =
    'v1=bf960ef1988e889ecebb12b671aaf3f82e1a3136fcc1cb5b11869dc8cd5a2abf';
  const EVENT_ID_V2 = '22222222-2222-4222-8222-222222222222';
  const EXPECTED_SIG_V2 =
    'v1=894a8ddbb60c18e90451413e940fbec1d34a5c3383c1564a03051d02487f206c';

  const account = { id: 1, cancelWebhookUrl: 'https://example.com/webhook' } as never;

  let dateNowSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let httpPost: jest.Mock;
  let logRepository: { create: jest.Mock; save: jest.Mock };
  let configGet: jest.Mock;

  function buildSender() {
    return new CouponCancelWebhookSender(
      logRepository as never,
      { post: httpPost } as never,
      { get: configGet } as never,
    );
  }

  beforeEach(() => {
    httpPost = jest.fn().mockReturnValue(of({ status: 200, data: 'ok' }));
    logRepository = {
      create: jest.fn((entity) => entity),
      save: jest.fn().mockResolvedValue(undefined),
    };
    configGet = jest.fn();
    dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(FIXED_TS_MS);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
    warnSpy.mockRestore();
    (randomUUID as jest.Mock).mockReset();
    jest.clearAllMocks();
  });

  it('secret 설정 시 ASCII 페이로드에 대해 openssl 오라클과 동일한 서명 헤더를 부착한다 (V1)', async () => {
    (randomUUID as jest.Mock).mockReturnValue(EVENT_ID_V1);
    configGet.mockReturnValue(SECRET);
    const sender = buildSender();

    await sender.send(account, null, {
      trId: 'EXT_TEST',
      couponStatus: 'CANCEL',
      cancelledAt: CANCELLED_AT,
    });

    expect(httpPost).toHaveBeenCalledTimes(1);
    const [url, body, config] = httpPost.mock.calls[0];
    expect(url).toBe('https://example.com/webhook');
    // 서명 대상 = 전송 body: post 두번째 인자는 문자열이어야 한다(객체 아님).
    expect(typeof body).toBe('string');
    expect(body).toBe(
      JSON.stringify({
        eventType: 'COUPON_CANCEL',
        eventId: EVENT_ID_V1,
        trId: 'EXT_TEST',
        couponStatus: 'CANCEL',
        cancelledAt: CANCELLED_AT.toISOString(),
      }),
    );
    expect(config.headers['Content-Type']).toBe('application/json');
    expect(config.headers['X-Webhook-Signature']).toBe(EXPECTED_SIG_V1);
    expect(config.headers['X-Webhook-Timestamp']).toBe(String(FIXED_TS_SEC));
  });

  it('비ASCII(한글) 페이로드에서도 UTF-8 바이트 기준으로 오라클과 서명이 일치한다 (V2)', async () => {
    (randomUUID as jest.Mock).mockReturnValue(EVENT_ID_V2);
    configGet.mockReturnValue(SECRET);
    const sender = buildSender();

    await sender.send(account, null, {
      trId: '테스트_거래_한글',
      couponStatus: 'CANCEL',
      cancelledAt: CANCELLED_AT,
    });

    const [, body, config] = httpPost.mock.calls[0];
    expect(config.headers['X-Webhook-Signature']).toBe(EXPECTED_SIG_V2);
    // JSON.stringify 는 비ASCII 를 유니코드 이스케이프하지 않고 UTF-8 로 유지한다.
    expect(body).toContain('테스트_거래_한글');
  });

  it('secret 미설정 시 서명 헤더 없이 전송하고 eventId/trId 포함 WARN 을 남긴다', async () => {
    (randomUUID as jest.Mock).mockReturnValue(EVENT_ID_V1);
    configGet.mockReturnValue(undefined);
    const sender = buildSender();

    await sender.send(account, null, {
      trId: 'EXT_TEST',
      couponStatus: 'CANCEL',
      cancelledAt: CANCELLED_AT,
    });

    expect(httpPost).toHaveBeenCalledTimes(1);
    const [, body, config] = httpPost.mock.calls[0];
    expect(typeof body).toBe('string');
    expect(config.headers['Content-Type']).toBe('application/json');
    expect(config.headers['X-Webhook-Signature']).toBeUndefined();
    expect(config.headers['X-Webhook-Timestamp']).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMsg = String(warnSpy.mock.calls[0][0]);
    expect(warnMsg).toContain(EVENT_ID_V1);
    expect(warnMsg).toContain('EXT_TEST');
  });

  it('잘못된 secret 은 오라클 기대 서명과 다르다(음성 케이스)', async () => {
    (randomUUID as jest.Mock).mockReturnValue(EVENT_ID_V1);
    configGet.mockReturnValue('wrong-secret');
    const sender = buildSender();

    await sender.send(account, null, {
      trId: 'EXT_TEST',
      couponStatus: 'CANCEL',
      cancelledAt: CANCELLED_AT,
    });

    const [, , config] = httpPost.mock.calls[0];
    expect(config.headers['X-Webhook-Signature']).not.toBe(EXPECTED_SIG_V1);
    expect(config.headers['X-Webhook-Signature']).toMatch(/^v1=[0-9a-f]{64}$/);
  });
});
