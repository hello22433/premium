import { DeliveryBatchService } from './delivery.batch.service';
import { DeferredDeliveryError } from '../interface/deferred.delivery.error';
import { IOrderDeliveryStatus } from '../interface/order.delivery.status';
import { IOrderSendMethod } from '../../order/interface/order.send.method';
import { IOrderType } from '../../order/interface/order.type';
import { IProductType } from '../../product/interface/product.type';
import { SsgTryError } from '../../partner_company_extern/infra/ssg.issue';
import { PinIssueCommandStatus, SsgPinResolution } from '../interface/pin.issue.command.status';

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
      product: { type: IProductType.SSG, partnerCompany: { type: 'SSG' } },
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

  describe('processOneDeliveryInternal — P24 PIN command authority', () => {
    let sut: DeliveryBatchService;
    let createActiveCommand: jest.Mock;
    let consumeInitialIssueAuthority: jest.Mock;
    let consumeNotIssuedRetryAuthority: jest.Mock;
    let recordResolution: jest.Mock;
    let markOpsReviewRequired: jest.Mock;
    let markSucceeded: jest.Mock;
    let markSendFail: jest.Mock;
    let refundForFail: jest.Mock;
    const authority = {
      commandId: 'command-9001',
      ownerToken: TOKEN.toISOString(),
      generation: '0',
      workflowVersion: '0',
    };

    beforeEach(() => {
      createActiveCommand = jest.fn().mockResolvedValue(authority.commandId);
      consumeInitialIssueAuthority = jest.fn().mockResolvedValue(true);
      consumeNotIssuedRetryAuthority = jest.fn().mockResolvedValue(true);
      recordResolution = jest.fn().mockResolvedValue(true);
      markOpsReviewRequired = jest.fn().mockResolvedValue(true);
      markSucceeded = jest.fn().mockResolvedValue(true);
      markSendFail = jest.fn();
      refundForFail = jest.fn().mockResolvedValue(undefined);

      sut = Object.create(DeliveryBatchService.prototype);
      (sut as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
      (sut as any).cutoverGuard = { isWorkflowResend: jest.fn().mockResolvedValue(null) };
      (sut as any).ssgEventRepository = { findOne: jest.fn().mockResolvedValue({ id: 42, no: 'EV1', order: 1 }) };
      (sut as any).pinIssueCommandService = {
        createActiveCommand,
        consumeInitialIssueAuthority,
        consumeNotIssuedRetryAuthority,
        recordResolution,
        markOpsReviewRequired,
        markSucceeded,
      };
      (sut as any).markSendFail = markSendFail;
      (sut as any).refundForFail = refundForFail;
      (sut as any).shouldHoldRefundForFail = jest.fn().mockResolvedValue(true);
      (sut as any).updateDeliveryOwned = jest.fn().mockResolvedValue(true);
      (sut as any).createCouponImage = jest.fn().mockResolvedValue('img');
      (sut as any).cryptoCipher = {
        safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01011112222'),
        encryptDeliveryTarget: jest.fn().mockReturnValue('encrypted'),
        encryptJson: jest.fn().mockReturnValue('key'),
      };
      (sut as any).deliverySendService = { sendSms: jest.fn() };
    });

    it('pass 1 UNKNOWN은 소유 권한으로 RETRY_PENDING에만 기록하고 FAIL·환불하지 않는다', async () => {
      (sut as any).partnerCompanyExternService = {
        issue: jest.fn().mockRejectedValue(new SsgTryError('알 수 없는 오류입니다.')),
      };

      await expect((sut as any).processOneDeliveryInternal(makeDelivery(), TOKEN, true)).rejects.toBeInstanceOf(
        DeferredDeliveryError,
      );

      expect(createActiveCommand).toHaveBeenCalledWith(
        expect.objectContaining({ orderDeliveryId: 9001, ownerToken: TOKEN.toISOString() }),
      );
      expect(consumeInitialIssueAuthority).toHaveBeenCalledWith(authority);
      expect(recordResolution).toHaveBeenCalledWith(authority, {
        resolution: SsgPinResolution.UNKNOWN,
        status: PinIssueCommandStatus.RETRY_PENDING,
      });
      expect(markSendFail).not.toHaveBeenCalled();
      expect(refundForFail).not.toHaveBeenCalled();
    });

    it('pass 2 UNKNOWN은 같은 소유 권한을 OPS_REVIEW_REQUIRED로 올리고 FAIL·환불·INSERT하지 않는다', async () => {
      const issue = jest.fn();
      (sut as any).partnerCompanyExternService = {
        resolveDeferredSsgIssue: jest.fn().mockResolvedValue(SsgPinResolution.UNKNOWN),
        issue,
      };

      await expect(
        (sut as any).processOneDeliveryInternal(makeDelivery(), TOKEN, false, authority),
      ).rejects.toBeInstanceOf(DeferredDeliveryError);

      expect(markOpsReviewRequired).toHaveBeenCalledWith(authority, SsgPinResolution.UNKNOWN);
      expect(markSendFail).not.toHaveBeenCalled();
      expect(refundForFail).not.toHaveBeenCalled();
      expect(issue).not.toHaveBeenCalled();
      expect(consumeNotIssuedRetryAuthority).not.toHaveBeenCalled();
    });

    it('pass 2 CONFIRMED는 기존 PIN을 재사용하고 새 INSERT 없이 성공 처리한다', async () => {
      const delivery = makeDelivery();
      const issue = jest.fn();
      (sut as any).partnerCompanyExternService = {
        resolveDeferredSsgIssue: jest.fn().mockImplementation(async (od: any) => {
          od.barCode = '80000001';
          od.personalCode = '01312345678';
          return SsgPinResolution.CONFIRMED;
        }),
        issue,
      };

      const result = await (sut as any).processOneDeliveryInternal(delivery, TOKEN, false, authority);

      expect(issue).not.toHaveBeenCalled();
      expect(markSucceeded).toHaveBeenCalledWith(authority);
      expect(result.deliveryHistory.isSuccess).toBe(true);
    });

    it.each([SsgPinResolution.UNKNOWN, SsgPinResolution.MULTIPLE_CONFIRMED])(
      'pass 2 %s는 신규 INSERT 권한을 소비하지 않고 운영 검토로 중단한다',
      async (resolution) => {
        const issue = jest.fn();
        (sut as any).partnerCompanyExternService = {
          resolveDeferredSsgIssue: jest.fn().mockResolvedValue(resolution),
          issue,
        };

        await expect(
          (sut as any).processOneDeliveryInternal(makeDelivery(), TOKEN, false, authority),
        ).rejects.toBeInstanceOf(DeferredDeliveryError);

        expect(markOpsReviewRequired).toHaveBeenCalledWith(authority, resolution);
        expect(issue).not.toHaveBeenCalled();
      },
    );

    it('pass 2 NOT_ISSUED만 한 번의 재발급 권한을 소비한다', async () => {
      (sut as any).partnerCompanyExternService = {
        resolveDeferredSsgIssue: jest.fn().mockResolvedValue(SsgPinResolution.NOT_ISSUED),
        issue: jest.fn().mockImplementation(async (od: any) => {
          od.barCode = '80000001';
        }),
      };

      await (sut as any).processOneDeliveryInternal(makeDelivery(), TOKEN, false, authority);

      expect(recordResolution).toHaveBeenCalledWith(authority, {
        resolution: SsgPinResolution.NOT_ISSUED,
        status: PinIssueCommandStatus.RETRYING,
      });
      expect(consumeNotIssuedRetryAuthority).toHaveBeenCalledWith(authority);
    });

    it('비판정 불가 실패는 TERMINAL로 기록한 뒤 기존 FAIL 처리한다', async () => {
      (sut as any).partnerCompanyExternService = {
        issue: jest.fn().mockRejectedValue(new Error('잔액 부족')),
      };

      const result = await (sut as any).processOneDeliveryInternal(makeDelivery(), TOKEN, true);

      expect(recordResolution).toHaveBeenCalledWith(
        authority,
        { resolution: SsgPinResolution.UNKNOWN, status: PinIssueCommandStatus.TERMINAL },
      );
      expect(markSendFail).toHaveBeenCalled();
      expect(result.deliveryHistory.isSuccess).toBe(false);
    });
  });

  describe('issueAndSend — pass 2 는 DB 에서 다시 읽어 재실행한다', () => {
    let sut: DeliveryBatchService;
    let findClaimed: jest.Mock;
    let processOne: jest.Mock;
    let findDeferredForResolution: jest.Mock;

    beforeEach(() => {
      sut = Object.create(DeliveryBatchService.prototype);
      (sut as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
      // concurrencyLimit 은 getter 전용이라 대입이 안 된다 — 프로퍼티를 덮어쓴다.
      Object.defineProperty(sut, 'concurrencyLimit', { get: () => 2, configurable: true });
      (sut as any).claimWaitDeliveries = jest.fn().mockResolvedValue(2);
      (sut as any).deliverySendHistoryRepository = { insert: jest.fn().mockResolvedValue({}) };
      (sut as any).markOrderTerminalAndSettle = jest.fn().mockResolvedValue(undefined);
      findDeferredForResolution = jest.fn().mockResolvedValue([]);
      (sut as any).pinIssueCommandService = {
        findDeferredForResolution,
      };

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
      findDeferredForResolution.mockImplementation(async (ownerToken: string) => [
        {
          id: 'command-2',
          orderDeliveryId: 2,
          ownerToken,
          generation: '0',
          workflowVersion: '0',
        },
      ]);

      await sut.issueAndSend();

      // RETRY_PENDING은 일반 claim 경로가 아닌, 같은 ownerToken의 표적 pass 2에만 보인다.
      expect(findClaimed).toHaveBeenCalledTimes(2);
      expect(findDeferredForResolution).toHaveBeenCalledWith(expect.any(String), [2]);
      expect(findClaimed.mock.calls[1][1]).toEqual([2]);
      const lastCall = processOne.mock.calls[processOne.mock.calls.length - 1];
      expect(lastCall[1]).toBe(false);
      expect(lastCall[2]).toEqual({
        commandId: 'command-2',
        ownerToken: findDeferredForResolution.mock.calls[0][0],
        generation: '0',
        workflowVersion: '0',
      });
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
