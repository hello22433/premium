// 실제 DB 연결이 없는 단위 테스트이므로 @Transactional 을 no-op 으로 mock 한다.
// (execResend 는 @Transactional() + pessimistic_write 로 감싸여 있다. 관례: dedup.spec)
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_t: unknown, _k: unknown, d: unknown) => d,
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSources: jest.fn(),
}));

import { BadRequestException, ConflictException } from '@nestjs/common';
import { CustomerServiceService } from './customer.service.service';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { MUTATION_CLAIM_STALE_MS } from '../../delivery/interface/order.delivery.mutation.claim';

/**
 * CS "재전송"(execResend) — **여섯 번째 발송 경로**.
 *
 * 4차 리뷰까지 이 경로는 lease 도, 쿠폰상태 가드도 없었다. 심지어 코드에 적어 둔
 * "발송 경로 5개" 목록 자체가 이걸 빠뜨려서 3라운드 동안 보이지 않았다.
 *
 * csResendAs* 는 쿠폰 이미지와 핀번호가 담긴 문자를 고객에게 그대로 보낸다. 가드는 두 축이다:
 *
 *  ① 폐기 쿠폰 — **레이스도 아니고 결정적이다.**
 *     status(COMPLETE)와 coupon_status(CANCEL)는 별개 축이라, 발송 완료 후 폐기·환불된 건은
 *     status=COMPLETE + coupon_status=CANCEL 로 남는다. 운영자가 "재전송" 을 누르면 협력사에서
 *     이미 죽고 환불까지 끝난 핀이 다시 배달된다.
 *
 *  ② 진행중인 변형 — **비관락으로는 못 막는다.**
 *     execDiscard 는 lease 를 잡은 뒤 행 락을 놓고 협력사 cancel(외부 통신, 수 초)에 들어간다.
 *     그 창에서 이 비관락은 즉시 획득되므로 아무것도 막지 못한다. lease 를 읽어야만 안다.
 */
describe('CustomerServiceService — execResend (CS 재전송) 발송 가드', () => {
  const ORDER_DELIVERY_ID = 8001;

  let service: any;
  let deliveryBatchService: any;
  let orderDeliveryRepository: any;
  let orderHistoryRepository: any;
  let qb: any;

  const buildLocked = (over: Record<string, any> = {}) =>
    ({
      id: ORDER_DELIVERY_ID,
      reportState: null,
      couponStatus: OrderDeliveryCouponStatus.NOT_USED,
      mutationClaimedAt: null,
      ...over,
    }) as any;

  const buildMap = (extraType = 'forced_mms') => ({
    orderDeliveryId: ORDER_DELIVERY_ID,
    userId: 9,
    type: '재전송',
    content: '',
    beforeChange: '',
    afterChange: '',
    sendMethod: 'MMS',
    extraType,
  });

  beforeEach(() => {
    qb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
      // lease 획득 CAS 결과. affected=1 = 획득/탈취 성공, 0 = 활성 lease 라 거절.
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    orderDeliveryRepository = {
      createQueryBuilder: jest.fn(() => qb),
      // releaseMutationLease(owner-guarded 해제)
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    orderHistoryRepository = {
      count: jest.fn().mockResolvedValue(0), // dedup 창 통과
      create: jest.fn((x: any) => x),
      save: jest.fn().mockResolvedValue(undefined),
    };
    deliveryBatchService = {
      csResendAsSms: jest.fn().mockResolvedValue(undefined),
      csResendAsMms: jest.fn().mockResolvedValue(undefined),
      csResendAsAlimTalk: jest.fn().mockResolvedValue(undefined),
      csResendAsEmail: jest.fn().mockResolvedValue(undefined),
    };

    service = Object.create(CustomerServiceService.prototype);
    // §9 컷오버 게이트 — 단위 테스트 기본값은 '미전환 건'(legacy 경로 그대로 통과).
    (service as any).cutoverGuard = {
      assertLegacyAllowed: jest.fn().mockResolvedValue(undefined),
      assertRefundExecutionAllowed: jest.fn().mockResolvedValue(undefined),
      isCutover: jest.fn().mockResolvedValue(false),
      splitLegacyAllowed: jest.fn(async (ids: number[]) => ({ allowed: ids, blocked: [] })),
    };
    service.orderDeliveryRepository = orderDeliveryRepository;
    service.orderHistoryRepository = orderHistoryRepository;
    service.deliveryBatchService = deliveryBatchService;
    service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  });

  const noSendHappened = () => {
    expect(deliveryBatchService.csResendAsMms).not.toHaveBeenCalled();
    expect(deliveryBatchService.csResendAsSms).not.toHaveBeenCalled();
    expect(deliveryBatchService.csResendAsAlimTalk).not.toHaveBeenCalled();
    expect(deliveryBatchService.csResendAsEmail).not.toHaveBeenCalled();
  };

  it('정상(살아있는 쿠폰 + lease 없음): 발송한다', async () => {
    qb.getOne.mockResolvedValue(buildLocked());

    await service.execResend(buildMap());

    expect(deliveryBatchService.csResendAsMms).toHaveBeenCalledWith(ORDER_DELIVERY_ID);
  });

  it.each([[OrderDeliveryCouponStatus.CANCEL], [OrderDeliveryCouponStatus.REFUND_CANCEL]])(
    '폐기·환불된 쿠폰(%s)은 재전송하지 않는다 — status 는 COMPLETE 라 종전 가드를 그대로 통과했다',
    async (couponStatus) => {
      qb.getOne.mockResolvedValue(buildLocked({ couponStatus }));

      await expect(service.execResend(buildMap())).rejects.toBeInstanceOf(BadRequestException);

      noSendHappened();
      // 이력도 남기면 안 된다 — 보낸 적이 없다
      expect(orderHistoryRepository.save).not.toHaveBeenCalled();
    },
  );

  it('변형 lease 활성(폐기/취소/재발행 진행중)이면 409 로 거절한다', async () => {
    qb.getOne.mockResolvedValue(buildLocked({ mutationClaimedAt: new Date() }));
    qb.execute.mockResolvedValue({ affected: 0 }); // 활성 lease → CAS 실패

    await expect(service.execResend(buildMap())).rejects.toBeInstanceOf(ConflictException);

    noSendHappened();
  });

  it('stale lease(5분 초과)는 잔재이므로 막지 않는다 — 크래시 후 영구 차단 방지', async () => {
    const stale = new Date(Date.now() - MUTATION_CLAIM_STALE_MS - 60_000);
    qb.getOne.mockResolvedValue(buildLocked({ mutationClaimedAt: stale }));
    qb.execute.mockResolvedValue({ affected: 1 }); // stale → 탈취 성공

    await service.execResend(buildMap());

    expect(deliveryBatchService.csResendAsMms).toHaveBeenCalled();
  });

  /**
   * ★ 리뷰 지적 회귀 — lease 는 **읽기가 아니라 탈취**여야 한다 (3eb7270·8a8f256 과 동일 계열).
   *
   * 종전에는 `if (locked.mutationClaimedAt >= stale) throw` 로 **읽고 통과만** 했다.
   * 그러면 이미 밖에 나가 있는 좀비 A(execDiscard 가 lease 를 잡고 **행 락을 놓은 뒤**
   * 협력사 cancel 중 5분+ 지연)가 깨어났을 때, A 의 fenced write
   * (WHERE mutation_claimed_at = tA)가 여전히 일치해 **성공한다**.
   * → 이 재전송이 방금 보낸 쿠폰을 A 가 폐기·환불로 확정 → 고객은 죽은 핀을 받는다.
   *
   * 비관락은 "새로 시작하는 변형"만 막는다. 이미 나가 있는 좀비는 토큰을 덮어써야만 무력화된다.
   */
  describe('변형 lease — 읽기가 아니라 탈취 + 해제 (리뷰 회귀)', () => {
    const leaseSetArg = () => (qb.set.mock.calls[0] as any[])?.[0];
    const releaseCalls = () =>
      (orderDeliveryRepository.update.mock.calls as any[][]).filter((c) => c[1]?.mutationClaimedAt === null);

    it('발송 전에 내 토큰으로 lease 를 SET 한다 — 좀비의 fencing 을 무효화', async () => {
      qb.getOne.mockResolvedValue(buildLocked({ mutationClaimedAt: new Date(Date.now() - MUTATION_CLAIM_STALE_MS - 1) }));

      await service.execResend(buildMap());

      // SET 이 없으면 stale 토큰이 그대로 남아 좀비의 WHERE 가 계속 일치한다
      expect(leaseSetArg()).toEqual({ mutationClaimedAt: expect.any(Date) });
      expect(deliveryBatchService.csResendAsMms).toHaveBeenCalled();
    });

    it('lease 획득은 CAS — WHERE 에 (IS NULL OR < stale) 술어가 있다', async () => {
      qb.getOne.mockResolvedValue(buildLocked());

      await service.execResend(buildMap());

      const cas = (qb.andWhere.mock.calls as any[][]).find((c) => /mutationClaimedAt/i.test(String(c[0])));
      expect(cas).toBeDefined();
      expect(String(cas![0])).toMatch(/mutationClaimedAt IS NULL/i);
      expect(String(cas![0])).toMatch(/mutationClaimedAt\s*<\s*:stale/i);
    });

    it('성공 시 owner-guarded 해제 — 내 토큰일 때만 푼다', async () => {
      qb.getOne.mockResolvedValue(buildLocked());

      await service.execResend(buildMap());

      expect(releaseCalls()).toHaveLength(1);
      expect(releaseCalls()[0][0]).toEqual({
        id: ORDER_DELIVERY_ID,
        mutationClaimedAt: leaseSetArg().mutationClaimedAt,
      });
    });

    it('발송이 실패해도 finally 에서 해제한다 — 안 풀면 5분간 폐기·취소가 전부 막힌다', async () => {
      qb.getOne.mockResolvedValue(buildLocked());
      deliveryBatchService.csResendAsMms.mockRejectedValue(new Error('gateway down'));

      await expect(service.execResend(buildMap())).rejects.toThrow('gateway down');

      expect(releaseCalls()).toHaveLength(1);
    });

    it('lease 를 못 잡았으면(409) 해제를 시도하지 않는다 — 남의 lease 를 건드리지 않음', async () => {
      qb.getOne.mockResolvedValue(buildLocked({ mutationClaimedAt: new Date() }));
      qb.execute.mockResolvedValue({ affected: 0 });

      await expect(service.execResend(buildMap())).rejects.toBeInstanceOf(ConflictException);

      expect(releaseCalls()).toHaveLength(0);
    });

    it('폐기 쿠폰이면 lease 를 잡기 전에 거절한다 (불필요한 점유 방지)', async () => {
      qb.getOne.mockResolvedValue(buildLocked({ couponStatus: OrderDeliveryCouponStatus.CANCEL }));

      await expect(service.execResend(buildMap())).rejects.toBeInstanceOf(BadRequestException);

      expect(qb.set).not.toHaveBeenCalled();
      expect(releaseCalls()).toHaveLength(0);
    });
  });
});
