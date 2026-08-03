import { DeliveryBatchService } from './delivery.batch.service';
import { DeferredDeliveryError } from '../interface/deferred.delivery.error';
import { IOrderDeliveryStatus } from '../interface/order.delivery.status';
import { IOrderSendMethod } from '../../order/interface/order.send.method';
import { IOrderType } from '../../order/interface/order.type';
import { IProductType } from '../../product/interface/product.type';
import { SsgTryError } from '../../partner_company_extern/infra/ssg.issue';

/**
 * PIN 발급 실패 2-pass 재시도 (`plans/2026-08-03-pin-issue-retry-wiring.md` §4.1).
 *
 * 배경: 2026-07-28~08-03 상용에서 SSG `GetSsgTry` 일시 오류로 발송 9건이 즉시 `FAIL` 확정됐고
 * 전부 운영자가 수동 재발송해 복구했다(지연 4.5분~61분). 계약 §2 조항 2 는 이 경우를
 * "`issueAndSend` 본 처리 종료 직후 1회 자동 재시도" 로 정하고 있다.
 *
 * 핵심 불변식 — **조회 실패는 "발급 안 됨" 이 아니라 "판정 불가" 다.**
 * 따라서 미룬 건은 pass 2 에서 `issue()` 를 진입점부터 재실행해야 하며, pass 1 의 엔티티
 * 스냅샷을 재사용하면 그 사이 SSG 에 반영된 이전 INSERT 를 못 보고 중복 PIN 이 나간다.
 *
 * 생성자 의존성이 많아 `Object.create` 로 프로토타입만 끌어온다(claim-mutation-lease.spec 관례).
 */
describe('DeliveryBatchService — PIN 발급 실패 2-pass 재시도', () => {
  const TOKEN = new Date('2026-08-03T01:00:00.000Z');

  const makeDelivery = (overrides: any = {}): any => ({
    id: 9001,
    claimedAt: TOKEN,
    status: IOrderDeliveryStatus.WAIT,
    barCode: null,
    personalCode: null,
    transactionId: 'ENM-9001',
    ssgTransactionId: null,
    ssgEventId: 42,
    deliveryTarget: 'encrypted',
    deliveryMethod: IOrderSendMethod.MMS,
    failedAt: null,
    orderProductMapping: {
      order: { id: 7001, type: IOrderType.SSG },
      product: { type: IProductType.COUPON, partnerCompany: { type: 'SSG' } },
    },
    ...overrides,
  });

  describe('processOneDeliveryForBatch — 미룬 건은 실패로 처리하지 않는다', () => {
    let sut: DeliveryBatchService;
    let odUpdate: jest.Mock;

    beforeEach(() => {
      odUpdate = jest.fn().mockResolvedValue({ affected: 1 });
      sut = Object.create(DeliveryBatchService.prototype);
      (sut as any).orderDeliveryRepository = { update: odUpdate };
      (sut as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    });

    it('DeferredDeliveryError → kind=deferred. claimedAt 을 풀지 않는다(다른 배치가 집어가면 안 된다)', async () => {
      (sut as any).processOneDeliveryInternal = jest.fn().mockRejectedValue(new DeferredDeliveryError(9001, null));

      const outcome = await (sut as any).processOneDeliveryForBatch(makeDelivery(), true);

      expect(outcome).toEqual({ kind: 'deferred' });
      const claimReset = odUpdate.mock.calls.find(([, patch]: any[]) => patch?.claimedAt === null);
      expect(claimReset).toBeUndefined();
    });

    it('DeferredDeliveryError → 변형 lease 도 유지한다 (pass 2 전에 폐기·재발행이 끼어들면 안 된다)', async () => {
      (sut as any).processOneDeliveryInternal = jest.fn().mockRejectedValue(new DeferredDeliveryError(9001, null));

      await (sut as any).processOneDeliveryForBatch(makeDelivery(), true);

      const leaseRelease = odUpdate.mock.calls.find(([, patch]: any[]) => patch?.mutationClaimedAt === null);
      expect(leaseRelease).toBeUndefined();
    });

    it('일반 예외는 종전대로 — claimedAt reset + 변형 lease 해제 + kind=done/result=null', async () => {
      (sut as any).processOneDeliveryInternal = jest.fn().mockRejectedValue(new Error('발송 실패'));

      const outcome = await (sut as any).processOneDeliveryForBatch(makeDelivery(), true);

      expect(outcome).toEqual({ kind: 'done', result: null });
      expect(odUpdate.mock.calls.some(([, patch]: any[]) => patch?.claimedAt === null)).toBe(true);
      expect(odUpdate.mock.calls.some(([, patch]: any[]) => patch?.mutationClaimedAt === null)).toBe(true);
    });
  });

  describe('processOneDeliveryInternal — PIN 발급 실패 분류', () => {
    let sut: DeliveryBatchService;
    let markRetryPending: jest.Mock;
    let markExhausted: jest.Mock;
    let markTerminal: jest.Mock;
    let markSendFail: jest.Mock;
    let refundForFail: jest.Mock;

    beforeEach(() => {
      markRetryPending = jest.fn().mockResolvedValue(undefined);
      markExhausted = jest.fn().mockResolvedValue(undefined);
      markTerminal = jest.fn().mockResolvedValue(undefined);
      markSendFail = jest.fn();
      refundForFail = jest.fn().mockResolvedValue(undefined);

      sut = Object.create(DeliveryBatchService.prototype);
      (sut as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
      (sut as any).ssgEventRepository = { findOne: jest.fn().mockResolvedValue({ id: 42, no: 'EV1', order: 1 }) };
      (sut as any).pinIssueCommandService = {
        recordAttempt: jest.fn().mockResolvedValue(undefined),
        markSucceeded: jest.fn().mockResolvedValue(undefined),
        markRetryPending,
        markExhausted,
        markTerminal,
      };
      (sut as any).markSendFail = markSendFail;
      (sut as any).refundForFail = refundForFail;
      (sut as any).shouldHoldRefundForFail = jest.fn().mockResolvedValue(true);
      (sut as any).updateDeliveryOwned = jest.fn().mockResolvedValue(true);
      (sut as any).createCouponImage = jest.fn().mockResolvedValue('img');
    });

    it('pass 1(allowDefer=true) + SSG 조회 실패 → DeferredDeliveryError. FAIL 확정·환불 없음', async () => {
      (sut as any).partnerCompanyExternService = {
        issue: jest.fn().mockRejectedValue(new SsgTryError('알 수 없는 오류입니다.')),
      };

      await expect((sut as any).processOneDeliveryInternal(makeDelivery(), TOKEN, true)).rejects.toBeInstanceOf(
        DeferredDeliveryError,
      );

      // 미룬 건은 상태를 확정하지 않는다 — pass 2 가 깨끗한 상태에서 재판정해야 한다.
      expect(markSendFail).not.toHaveBeenCalled();
      expect(refundForFail).not.toHaveBeenCalled();
      expect(markRetryPending).toHaveBeenCalledWith(9001, '알 수 없는 오류입니다.');
      expect(markExhausted).not.toHaveBeenCalled();
    });

    it('pass 2(allowDefer=false) + 같은 조회 실패 → 종전대로 FAIL 확정 + EXHAUSTED 기록', async () => {
      (sut as any).partnerCompanyExternService = {
        issue: jest.fn().mockRejectedValue(new SsgTryError('알 수 없는 오류입니다.')),
      };

      const result = await (sut as any).processOneDeliveryInternal(makeDelivery(), TOKEN, false);

      expect(markSendFail).toHaveBeenCalledWith(expect.objectContaining({ id: 9001 }), IOrderDeliveryStatus.FAIL);
      expect(markExhausted).toHaveBeenCalled();
      expect(markRetryPending).not.toHaveBeenCalled();
      expect(result.deliveryHistory.isSuccess).toBe(false);
    });

    it('조회 실패가 아닌 실패는 pass 1 에서도 미루지 않는다 — 재시도해도 결과가 같다', async () => {
      (sut as any).partnerCompanyExternService = {
        issue: jest.fn().mockRejectedValue(new Error('잔액 부족')),
      };

      const result = await (sut as any).processOneDeliveryInternal(makeDelivery(), TOKEN, true);

      expect(markSendFail).toHaveBeenCalled();
      expect(markRetryPending).not.toHaveBeenCalled();
      expect(result.deliveryHistory.isSuccess).toBe(false);
    });

    it('비재시도 실패는 TERMINAL 로 기록한다 — EXHAUSTED 로 적으면 "재시도했는데 안 됐다" 로 왜곡된다', async () => {
      (sut as any).partnerCompanyExternService = {
        issue: jest.fn().mockRejectedValue(new Error('잔액 부족')),
      };

      await (sut as any).processOneDeliveryInternal(makeDelivery(), TOKEN, true);

      // §5.4 전이표: STARTED + TERMINAL → TERMINAL / RETRYING + 소진 → EXHAUSTED
      expect(markTerminal).toHaveBeenCalledWith(9001, '잔액 부족');
      expect(markExhausted).not.toHaveBeenCalled();
    });

    it('조회 실패를 pass 2 까지 소진했을 때만 EXHAUSTED 다', async () => {
      (sut as any).partnerCompanyExternService = {
        issue: jest.fn().mockRejectedValue(new SsgTryError('알 수 없는 오류입니다.')),
      };

      await (sut as any).processOneDeliveryInternal(makeDelivery(), TOKEN, false);

      expect(markExhausted).toHaveBeenCalledWith(9001, '알 수 없는 오류입니다.');
      expect(markTerminal).not.toHaveBeenCalled();
    });
  });

  describe('issueAndSend — pass 2 는 DB 에서 다시 읽어 재실행한다', () => {
    let sut: DeliveryBatchService;
    let findClaimed: jest.Mock;
    let processOne: jest.Mock;

    beforeEach(() => {
      sut = Object.create(DeliveryBatchService.prototype);
      (sut as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
      (sut as any).concurrencyLimit = 2;
      (sut as any).claimWaitDeliveries = jest.fn().mockResolvedValue(2);
      (sut as any).deliverySendHistoryRepository = { insert: jest.fn().mockResolvedValue({}) };
      (sut as any).markOrderTerminalAndSettle = jest.fn().mockResolvedValue(undefined);

      findClaimed = jest.fn();
      processOne = jest.fn();
      (sut as any).findClaimedDeliveries = findClaimed;
      (sut as any).processOneDeliveryForBatch = processOne;
    });

    it('pass 1 에서 미룬 건만 id 로 재조회해 pass 2 를 돈다 (allowDefer=false)', async () => {
      const ok = makeDelivery({ id: 1 });
      const deferredOd = makeDelivery({ id: 2 });

      findClaimed.mockResolvedValueOnce([ok, deferredOd]).mockResolvedValueOnce([deferredOd]);
      processOne
        .mockResolvedValueOnce({ kind: 'done', result: { deliveryHistory: {}, orderId: 7001 } })
        .mockResolvedValueOnce({ kind: 'deferred' })
        .mockResolvedValueOnce({ kind: 'done', result: { deliveryHistory: {}, orderId: 7001 } });

      await sut.issueAndSend();

      // 2회차 조회가 미룬 id 만 대상으로 한다 = pass 1 스냅샷 재사용이 아니라 fresh 재조회
      expect(findClaimed).toHaveBeenCalledTimes(2);
      expect(findClaimed.mock.calls[1][1]).toEqual([2]);

      // pass 2 는 allowDefer=false — 여기서 실패하면 확정한다(무한 보류 방지)
      const lastCall = processOne.mock.calls[processOne.mock.calls.length - 1];
      expect(lastCall[1]).toBe(false);
    });

    it('미룬 건이 없으면 재조회하지 않는다', async () => {
      findClaimed.mockResolvedValueOnce([makeDelivery({ id: 1 })]);
      processOne.mockResolvedValue({ kind: 'done', result: { deliveryHistory: {}, orderId: 7001 } });

      await sut.issueAndSend();

      expect(findClaimed).toHaveBeenCalledTimes(1);
    });

    it('pass 2 재조회에서 사라진 건(종결·lease 탈취)은 조용히 빠진다 — 예외 없음', async () => {
      const deferredOd = makeDelivery({ id: 2 });
      findClaimed.mockResolvedValueOnce([deferredOd]).mockResolvedValueOnce([]);
      processOne.mockResolvedValueOnce({ kind: 'deferred' });

      await expect(sut.issueAndSend()).resolves.toBeUndefined();
      expect(processOne).toHaveBeenCalledTimes(1);
    });
  });
});
