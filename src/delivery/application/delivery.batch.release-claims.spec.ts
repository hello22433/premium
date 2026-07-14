import { DeliveryBatchService } from './delivery.batch.service';
import { IOrderDeliveryStatus } from '../interface/order.delivery.status';

/**
 * releaseStaleBatchClaims 단위 테스트.
 *
 * DeliveryBatchService 생성자 의존성이 많아, Object.create 로 프로토타입만 끌어오고
 * 메서드가 실제로 쓰는 orderDeliveryRepository 만 주입해 격리 검증한다.
 *
 * 검증:
 *  - 해제 범위 = status = WAIT (FAIL/FAIL_SMS 미포함) + claimedAt IS NOT NULL
 *  - set 은 claimedAt: null 만 (status/resendAt 불변)
 */
describe('DeliveryBatchService.releaseStaleBatchClaims', () => {
  let qb: any;
  let sut: DeliveryBatchService;

  beforeEach(() => {
    qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 2 }),
    };
    sut = Object.create(DeliveryBatchService.prototype);
    (sut as any).orderDeliveryRepository = { createQueryBuilder: jest.fn(() => qb) };
  });

  it('status=WAIT + claimedAt IS NOT NULL 범위, claimedAt 만 null (status/resendAt 불변)', async () => {
    const released = await sut.releaseStaleBatchClaims();

    expect(released).toBe(2);
    // 대상 범위: status = WAIT (FAIL/FAIL_SMS 미포함)
    const statusWhere = qb.where.mock.calls.find((c: any[]) => /status = :status/.test(c[0]));
    expect(statusWhere).toBeDefined();
    expect(statusWhere![1].status).toBe(IOrderDeliveryStatus.WAIT);
    expect(statusWhere![1].status).not.toBe(IOrderDeliveryStatus.FAIL);
    expect(statusWhere![1].status).not.toBe(IOrderDeliveryStatus.FAIL_SMS);
    // claimedAt IS NOT NULL 조건
    expect(qb.andWhere.mock.calls.some((c: any[]) => /claimedAt IS NOT NULL/.test(c[0]))).toBe(true);
    // 상태 불변: set 은 claimedAt:null 만
    const setArg = qb.set.mock.calls[qb.set.mock.calls.length - 1][0];
    expect(setArg).toEqual({ claimedAt: null });
    expect(setArg).not.toHaveProperty('status');
    expect(setArg).not.toHaveProperty('resendAt');
  });

  it('affected 가 undefined 면 0 을 반환한다', async () => {
    // ①(lease 해제) → ②(claimedAt 해제) 두 문장이므로, 반환값을 정하는 것은 **두 번째** execute 다
    qb.execute.mockResolvedValueOnce({ affected: 1 }).mockResolvedValueOnce({});
    const released = await sut.releaseStaleBatchClaims();
    expect(released).toBe(0);
  });

  /**
   * ★ 배치가 잡은 변형 lease 도 함께 해제해야 한다 (리뷰 MEDIUM).
   *
   * claimWaitDeliveries 는 claimedAt 과 mutationClaimedAt 을 **같은 토큰으로 함께** 세팅한다.
   * claimedAt 만 지우면 mutation_claimed_at 이 남아, 재시작 후 최대 5분간 그 행의 폐기·외부취소·
   * 핀상태변경이 전부 "다른 처리가 진행 중" 으로 거절된다 — 실제로는 아무것도 안 돌고 있는데.
   * 하필 재시작 = 사고 대응 중인 시점에 사고 대응 액션이 막힌다.
   */
  describe('변형 lease 동시 해제 (D3-55 후속)', () => {
    it('배치가 잡은 lease 만 해제한다 — mutation_claimed_at = claimed_at 서명 대조', async () => {
      await sut.releaseStaleBatchClaims();

      const leaseSet = qb.set.mock.calls.find((c: any[]) => c[0] && 'mutationClaimedAt' in c[0]);
      expect(leaseSet).toBeDefined();
      expect(leaseSet![0]).toEqual({ mutationClaimedAt: null });
      // ★ 서명 조건이 없으면 멀티팟에서 **다른 팟이 진행 중인 재발행/폐기의 살아있는 lease** 를
      //   부팅 팟이 지워버린다 — 컬럼을 분리한 이유를 정면으로 부순다.
      expect(qb.andWhere.mock.calls.some((c: any[]) => /mutation_claimed_at = claimed_at/.test(c[0]))).toBe(true);
    });

    it('claimedAt 해제는 서명 조건 없이 — 구버전이 claim 한 행(lease NULL)도 반드시 풀린다', async () => {
      await sut.releaseStaleBatchClaims();

      // set 이 { claimedAt: null } 인 문장(②)에는 서명 조건이 붙으면 안 된다.
      // 붙이면 배포 직전 크래시로 남은 구버전 claim(mutation_claimed_at IS NULL)이 영원히 안 풀린다.
      expect(qb.execute).toHaveBeenCalledTimes(2);
      const claimSet = qb.set.mock.calls.find((c: any[]) => c[0] && !('mutationClaimedAt' in c[0]));
      expect(claimSet![0]).toEqual({ claimedAt: null });
    });
  });
});
