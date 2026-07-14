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

  it('SET 절은 claimedAt 만 — 배치 claim 이 변형 lease/쿠폰상태를 덮지 않는다', async () => {
    const claimedAt = new Date();

    await sut.claimWaitDeliveries(claimedAt);

    const setArg = qb.set.mock.calls[0][0];
    expect(setArg).toEqual({ claimedAt });
    // 배치 claim 은 변형 lease 의 소유자가 아니다 — 건드리면 남의 점유를 지운다
    expect(setArg).not.toHaveProperty('mutationClaimedAt');
    expect(setArg).not.toHaveProperty('couponStatus');
  });

  it('affected 를 그대로 반환한다 (undefined 면 0)', async () => {
    qb.execute.mockResolvedValueOnce({ affected: 3 });
    expect(await sut.claimWaitDeliveries(new Date())).toBe(3);

    qb.execute.mockResolvedValueOnce({});
    expect(await sut.claimWaitDeliveries(new Date())).toBe(0);
  });
});
