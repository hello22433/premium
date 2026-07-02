import { OrderReceiveService, couponViewDedupKey } from './order.receive.service';

/**
 * coupon-view 방문 로그 기록(recordCouponView) 및 dedup 키 검증.
 * 생성자 의존성이 많아 Object.create 로 우회 후 협력자만 mock 주입한다(discard 계열 spec 관례).
 * 실제 동시요청 원자성은 dedup_key UNIQUE + INSERT IGNORE(DB) 가 보장하므로, 여기서는
 * (a) read-then-write 경합 창이 없다(orIgnore 사용), (b) 같은 창의 동일 방문은 동일 dedupKey 를
 * 만든다 → DB 가 1건만 남긴다, 를 검증한다.
 */
describe('OrderReceiveService — coupon-view 방문 로그', () => {
  let service: any;
  let values: jest.Mock;
  let orIgnore: jest.Mock;
  let execute: jest.Mock;

  const HUMAN_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

  const insertedValues = () => values.mock.calls.map((c) => c[0]);

  beforeEach(() => {
    execute = jest.fn().mockResolvedValue({ identifiers: [] });
    orIgnore = jest.fn().mockReturnValue({ execute });
    values = jest.fn().mockReturnValue({ orIgnore });
    const insert = jest.fn().mockReturnValue({ values });
    const createQueryBuilder = jest.fn().mockReturnValue({ insert });

    service = Object.create(OrderReceiveService.prototype);
    service.couponViewLogRepository = { createQueryBuilder };
    // Object.create 는 필드 이니셜라이저를 건너뜀 — logger 직접 주입
    service.logger = { error: jest.fn(), log: jest.fn(), warn: jest.fn() };
  });

  it('실제 방문 시 IP/UA/referer/source/dedupKey 와 함께 INSERT IGNORE(원자적)로 1건 기록하고 봇 아님으로 남긴다', async () => {
    await service.recordCouponView(123, {
      ipAddress: '203.0.113.7',
      userAgent: HUMAN_UA,
      referer: 'https://pf.kakao.com/',
    });

    expect(values).toHaveBeenCalledTimes(1);
    expect(insertedValues()[0]).toEqual(
      expect.objectContaining({
        orderDeliveryId: 123,
        ipAddress: '203.0.113.7',
        userAgent: HUMAN_UA,
        referer: 'https://pf.kakao.com/',
        source: 'alimtalk',
        isBot: false,
        dedupKey: expect.stringMatching(/^123:203\.0\.113\.7:\d+$/),
      }),
    );
    // 원자적 dedup: read-then-write 없이 INSERT IGNORE 로만 기록한다.
    expect(orIgnore).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('알려진 크롤러 UA 는 isBot=true 로 기록한다', async () => {
    await service.recordCouponView(1, {
      ipAddress: '66.220.149.1',
      userAgent: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      referer: null,
    });

    expect(insertedValues()[0]).toEqual(expect.objectContaining({ isBot: true }));
  });

  it('insert 실패는 삼켜서 쿠폰 조회를 깨뜨리지 않는다(실패 격리)', async () => {
    execute.mockRejectedValue(new Error('db down'));

    await expect(
      service.recordCouponView(7, { ipAddress: '1.2.3.4', userAgent: HUMAN_UA, referer: null }),
    ).resolves.toBeUndefined();
    expect(service.logger.error).toHaveBeenCalled();
  });

  it('동시 호출 2건은 같은 시간버킷이면 동일 dedupKey 를 만든다(DB unique+IGNORE 로 1건만 잔존)', async () => {
    // 시간을 고정해 버킷 경계에서의 flakiness 를 제거한다.
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      await Promise.all([
        service.recordCouponView(9, { ipAddress: '5.5.5.5', userAgent: HUMAN_UA, referer: null }),
        service.recordCouponView(9, { ipAddress: '5.5.5.5', userAgent: HUMAN_UA, referer: null }),
      ]);
    } finally {
      nowSpy.mockRestore();
    }

    const keys = insertedValues().map((v) => v.dedupKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]); // 동일 키 → DB 가 원자적으로 1건만 유지
    expect(orIgnore).toHaveBeenCalledTimes(2);
  });

  it('테스트 발송(isTest)은 방문 로그를 남기지 않는다(alimTalkForTest 로 우회)', async () => {
    service.cryptoCipher = { decryptJson: jest.fn().mockReturnValue({ isTest: true, id: 42 }) };
    service.alimTalkForTest = jest.fn().mockResolvedValue({});
    const recordSpy = jest.spyOn(service, 'recordCouponView');

    await service.alimTalk({ encryptKey: 'enc' });

    expect(service.alimTalkForTest).toHaveBeenCalledTimes(1);
    expect(recordSpy).not.toHaveBeenCalled();
  });
});

describe('couponViewDedupKey', () => {
  it('같은 시간버킷의 동일 (orderDeliveryId, ip) 는 동일 키', () => {
    const t = 1_700_000_000_000;
    expect(couponViewDedupKey(10, '1.1.1.1', t)).toBe(couponViewDedupKey(10, '1.1.1.1', t + 9_999));
  });

  it('버킷을 넘어가면 다른 키(별개 방문)', () => {
    const t = 1_700_000_000_000;
    expect(couponViewDedupKey(10, '1.1.1.1', t)).not.toBe(couponViewDedupKey(10, '1.1.1.1', t + 10_001));
  });

  it('ip 가 null 이어도 안정적인 키를 만든다', () => {
    const t = 1_700_000_000_000;
    expect(couponViewDedupKey(10, null, t)).toBe(couponViewDedupKey(10, null, t));
    expect(couponViewDedupKey(10, null, t)).not.toBe(couponViewDedupKey(11, null, t));
  });
});
