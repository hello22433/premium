import { DeliveryBatchService } from './delivery.batch.service';
import { MUTATION_CLAIM_STALE_MS } from '../interface/order.delivery.mutation.claim';

/**
 * D3-55 후속 — 발송배치 claim 이 변형 lease(mutation_claimed_at) 활성 행을 제외하는지.
 *
 * 재발행(폐기후신규발송) tip 은 status=WAIT 로 INSERT 되므로, lease 제외가 없으면 발송배치가
 * 그 행을 집어가 재발행 자체 발송과 **이중 발송**이 된다(고객에게 문자 2통 + 발송비 중복).
 * 반대로 stale(5분 초과) lease 는 크래시 잔재이므로 정상 수거해야 한다 — 안 그러면 PIN 은
 * 발급됐는데 영원히 미발송으로 정체된다.
 *
 * 생성자 의존성이 많아 Object.create 로 프로토타입만 끌어오고 orderDeliveryRepository 만 주입한다.
 * (delivery.batch.release-claims.spec 관례)
 */
describe('DeliveryBatchService.claimWaitDeliveries — 변형 lease 제외 (D3-55 후속)', () => {
  let qb: any;
  let sut: DeliveryBatchService;

  beforeEach(() => {
    qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    sut = Object.create(DeliveryBatchService.prototype);
    (sut as any).orderDeliveryRepository = { createQueryBuilder: jest.fn(() => qb) };
  });

  /** WHERE 절 중 변형 lease 조건 (없으면 undefined). */
  const leaseCondition = (): any[] | undefined =>
    qb.andWhere.mock.calls.find((c: any[]) => /mutation_claimed_at/i.test(String(c[0])));

  it('claim WHERE 에 변형 lease 제외 조건이 포함된다 — 활성 lease(재발행 tip) 행은 배치가 집어가지 않는다', async () => {
    await sut.claimWaitDeliveries(new Date());

    const cond = leaseCondition();
    expect(cond).toBeDefined(); // 조건 자체가 없으면 재발행 tip 이중 발송
    // "비어 있거나(IS NULL) stale 인 행만" — 활성 lease 행은 매칭에서 빠진다
    expect(String(cond![0])).toMatch(/mutation_claimed_at IS NULL/i);
    expect(String(cond![0])).toMatch(/mutation_claimed_at\s*<\s*:mutationStale/i);
  });

  it('lease stale 임계 = claimedAt - 5분 (그보다 오래된 lease 만 수거 — 크래시 잔재 self-heal)', async () => {
    const claimedAt = new Date('2026-07-14T03:00:00.000Z');

    await sut.claimWaitDeliveries(claimedAt);

    const cond = leaseCondition();
    const stale: Date = cond![1].mutationStale;
    expect(stale).toBeInstanceOf(Date);
    expect(stale.getTime()).toBe(claimedAt.getTime() - MUTATION_CLAIM_STALE_MS);
    expect(MUTATION_CLAIM_STALE_MS).toBe(5 * 60 * 1000);
  });

  /**
   * 리뷰 CONFIRMED(HIGH): stale lease 를 WHERE 로 통과시키기만 하고 SET 으로 탈취하지 않으면,
   * 원 소유자(좀비)의 fencing 조건(mutation_claimed_at = :myClaimAt)이 여전히 일치해
   * affected=1 로 성공한다 — fencing 이 설계된 바로 그 상황에서 발동하지 않는다.
   * 배치가 lease 를 실제로 가져와야 좀비의 쓰기가 affected=0 으로 떨어져 중단 경로를 탄다.
   */
  it('SET 절이 변형 lease 를 탈취한다 — 좀비의 fencing 이 실제로 발동하도록', async () => {
    const claimedAt = new Date();

    await sut.claimWaitDeliveries(claimedAt);

    const setArg = qb.set.mock.calls[0][0];
    expect(setArg).toEqual({ claimedAt, mutationClaimedAt: claimedAt });
  });

  it('SET 절에 쿠폰상태가 없다 — 배치 claim 은 coupon_status 를 덮지 않는다', async () => {
    await sut.claimWaitDeliveries(new Date());

    const setArg = qb.set.mock.calls[0][0];
    expect(setArg).not.toHaveProperty('couponStatus');
    expect(setArg).not.toHaveProperty('discardedAt');
  });

  it('affected 를 그대로 반환한다 (undefined 면 0)', async () => {
    qb.execute.mockResolvedValueOnce({ affected: 3 });
    expect(await sut.claimWaitDeliveries(new Date())).toBe(3);

    qb.execute.mockResolvedValueOnce({});
    expect(await sut.claimWaitDeliveries(new Date())).toBe(0);
  });
});

/**
 * claim 이 변형 lease 를 탈취(위 스펙)하므로, 배치는 처리 종료 시 반드시 그것을 반납해야 한다.
 * 반납하지 않으면 발송 직후부터 stale(5분)까지 그 행에 대한 폐기·외부취소가 전부 거절된다
 * (acquireMutationLease 가 활성 lease 로 보고 affected=0).
 */
describe('DeliveryBatchService.processOneDeliveryForBatch — 변형 lease 반납 (D3-55 후속)', () => {
  const CLAIM_TOKEN = new Date('2026-07-14T10:00:00.123456Z');
  let update: jest.Mock;
  let sut: DeliveryBatchService;

  const makeDelivery = () => ({ id: 777, claimedAt: CLAIM_TOKEN, status: 'WAIT' }) as any;

  /** mutationClaimedAt=null 을 쓰는 update 호출 (= lease 해제). */
  const releaseCalls = () =>
    (update.mock.calls as unknown as any[][]).filter((c) => c[1] && c[1].mutationClaimedAt === null);

  beforeEach(() => {
    update = jest.fn().mockResolvedValue({ affected: 1 });
    sut = Object.create(DeliveryBatchService.prototype);
    (sut as any).orderDeliveryRepository = { update };
    (sut as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  });

  it('성공 경로: finally 에서 owner-guarded 해제', async () => {
    (sut as any).processOneDeliveryInternal = jest.fn().mockResolvedValue({ deliveryHistory: {}, orderId: 1 });

    await (sut as any).processOneDeliveryForBatch(makeDelivery());

    expect(releaseCalls()).toHaveLength(1);
    expect(releaseCalls()[0][0]).toEqual({ id: 777, mutationClaimedAt: CLAIM_TOKEN });
  });

  it('실패 경로: claimedAt reset 과 별개로 변형 lease 도 해제된다', async () => {
    (sut as any).processOneDeliveryInternal = jest.fn().mockRejectedValue(new Error('발송 실패'));

    await (sut as any).processOneDeliveryForBatch(makeDelivery());

    expect(releaseCalls()).toHaveLength(1);
    expect(releaseCalls()[0][0]).toEqual({ id: 777, mutationClaimedAt: CLAIM_TOKEN });
  });

  it('실패 경로의 claimedAt reset 은 owner guard 를 건다 — 남의 claim 을 풀지 않는다', async () => {
    (sut as any).processOneDeliveryInternal = jest.fn().mockRejectedValue(new Error('발송 실패'));

    await (sut as any).processOneDeliveryForBatch(makeDelivery());

    const reset = (update.mock.calls as unknown as any[][]).find((c) => c[1] && c[1].claimedAt === null);
    expect(reset).toBeDefined();
    expect(reset![0]).toEqual({ id: 777, status: 'WAIT', claimedAt: CLAIM_TOKEN });
  });
});
