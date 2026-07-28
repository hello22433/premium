import { DeliveryBatchService } from './delivery.batch.service';
import { IOrderDeliveryStatus } from '../interface/order.delivery.status';

/**
 * releaseStaleBatchClaims 단위 테스트.
 *
 * DeliveryBatchService 생성자 의존성이 많아, Object.create 로 프로토타입만 끌어오고
 * 메서드가 실제로 쓰는 orderDeliveryRepository 만 주입해 격리 검증한다.
 *
 * 부팅(listen 전) 1회 sweep 이므로, 여기서 잘못 지우면 **운영 중인 다른 팟의 작업**이 깨진다.
 * 검증:
 *  - ①(변형 lease 해제) → ②(claimedAt 해제) **두 문장**, 이 순서
 *  - ① 은 `mutation_claimed_at = claimed_at` 서명 대조로 **배치가 잡은 lease 만** 해제
 *  - ② 는 **서명 조건 없이** — 구버전 claim 잔재(lease NULL)도 반드시 풀려야 한다
 *  - 해제 범위 = status = WAIT (FAIL/FAIL_SMS 미포함) + claimedAt IS NOT NULL
 *  - set 은 각각 lease/claimedAt 만 (status/resendAt 불변)
 */
describe('DeliveryBatchService.releaseStaleBatchClaims', () => {
  let sut: DeliveryBatchService;
  /**
   * ★ createQueryBuilder 호출마다 **새 qb** 를 준다 (문장별 격리).
   *
   * qb 를 하나만 공유하면 ①과 ②의 andWhere 호출이 한 배열에 섞여, "②에는 서명 조건이 없어야
   * 한다" 를 **검증할 수 없게 된다** — ①이 부른 조건이 같은 풀에 있으니 구분이 안 된다.
   * 그 상태로는 ②에 서명 조건을 붙이는 회귀(= 구버전 claim 이 영원히 안 풀림)가 초록으로 통과한다.
   */
  let statements: any[];
  /** 문장별 execute 결과. 미지정이면 { affected: 2 }. */
  let executeResults: any[];

  const makeQb = () => {
    const index = statements.length;
    const q: any = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn(() => Promise.resolve(executeResults[index] ?? { affected: 2 })),
    };
    statements.push(q);
    return q;
  };

  /** 그 문장이 건 조건(where + andWhere) SQL 조각 전체 */
  const conditionsOf = (q: any): string[] =>
    [...q.where.mock.calls, ...q.andWhere.mock.calls].map((c: any[]) => String(c[0]));

  const setArgOf = (q: any) => q.set.mock.calls[q.set.mock.calls.length - 1][0];

  const SIGNATURE = /mutation_claimed_at\s*=\s*claimed_at/;

  beforeEach(() => {
    statements = [];
    executeResults = [];
    sut = Object.create(DeliveryBatchService.prototype);
    // §9 컷오버 게이트 — 단위 테스트 기본값은 '미전환 건'(legacy 경로 그대로 통과).
    (sut as any).cutoverGuard = {
      assertLegacyAllowed: jest.fn().mockResolvedValue(undefined),
      assertRefundExecutionAllowed: jest.fn().mockResolvedValue(undefined),
      isCutover: jest.fn().mockResolvedValue(false),
      splitLegacyAllowed: jest.fn(async (ids: number[]) => ({ allowed: ids, blocked: [] })),
    };
    (sut as any).orderDeliveryRepository = { createQueryBuilder: jest.fn(() => makeQb()) };
  });

  it('두 문장이다 — ①변형 lease 해제 → ②claimedAt 해제, 이 순서', async () => {
    await sut.releaseStaleBatchClaims();

    expect(statements).toHaveLength(2);
    // ★ 순서가 뒤집히면 안 된다. ②가 먼저 돌아 claimed_at 이 NULL 이 되면, ①의
    //   `mutation_claimed_at = claimed_at` 은 NULL = NULL → SQL 에서 영원히 false 가 되어
    //   **lease 가 단 한 건도 해제되지 않는다**(부팅 sweep 이 lease 누수를 못 고친다).
    expect(setArgOf(statements[0])).toEqual({ mutationClaimedAt: null });
    expect(setArgOf(statements[1])).toEqual({ claimedAt: null });
  });

  it('status=WAIT + claimedAt IS NOT NULL 범위, claimedAt 만 null (status/resendAt 불변)', async () => {
    const released = await sut.releaseStaleBatchClaims();

    expect(released).toBe(2);

    // 두 문장 모두 같은 범위여야 한다 — 한쪽만 넓으면 남의 행을 건드린다
    for (const q of statements) {
      const statusWhere = q.where.mock.calls.find((c: any[]) => /status = :status/.test(c[0]));
      expect(statusWhere).toBeDefined();
      expect(statusWhere![1].status).toBe(IOrderDeliveryStatus.WAIT);
      expect(statusWhere![1].status).not.toBe(IOrderDeliveryStatus.FAIL);
      expect(statusWhere![1].status).not.toBe(IOrderDeliveryStatus.FAIL_SMS);
      expect(conditionsOf(q).some((c) => /claimedAt IS NOT NULL/.test(c))).toBe(true);
    }

    // 상태 불변: claimedAt 문장의 set 은 claimedAt:null 만
    const claimSet = setArgOf(statements[1]);
    expect(claimSet).toEqual({ claimedAt: null });
    expect(claimSet).not.toHaveProperty('status');
    expect(claimSet).not.toHaveProperty('resendAt');
  });

  it('affected 가 undefined 면 0 을 반환한다', async () => {
    // 반환값을 정하는 것은 **두 번째**(claimedAt) 문장이다
    executeResults = [{ affected: 1 }, {}];

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
    it('①lease 해제는 mutation_claimed_at = claimed_at 서명이 있는 행만 — 남의 살아있는 lease 를 지우지 않는다', async () => {
      await sut.releaseStaleBatchClaims();

      const lease = statements[0];
      expect(setArgOf(lease)).toEqual({ mutationClaimedAt: null });
      // 서명 조건이 없으면 멀티팟에서 **다른 팟이 진행 중인 재발행/폐기의 살아있는 lease** 를
      // 부팅 팟이 지워버린다 — 컬럼을 분리한 이유를 정면으로 부순다.
      expect(conditionsOf(lease).some((c) => SIGNATURE.test(c))).toBe(true);
    });

    it('②claimedAt 해제에는 서명 조건이 **없어야** 한다 — 구버전이 claim 한 행(lease NULL)도 반드시 풀린다', async () => {
      await sut.releaseStaleBatchClaims();

      const claim = statements[1];
      expect(setArgOf(claim)).toEqual({ claimedAt: null });
      // ★ 여기에 서명 조건을 "일관성 있게" 붙이는 리팩터가 바로 회귀다:
      //   배포 직전 크래시로 남은 구버전 claim(mutation_claimed_at IS NULL)은 서명이 안 맞아
      //   claimed_at 이 영원히 안 풀리고, 그 행은 어떤 배치도 다시 집지 못하는 좀비가 된다.
      expect(conditionsOf(claim).some((c) => SIGNATURE.test(c))).toBe(false);
    });
  });
});
