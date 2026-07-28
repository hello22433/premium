import { ConflictException } from '@nestjs/common';
import { DeliveryCutoverGuardService, RefundExecutionFencing } from './delivery-cutover-guard.service';
import {
  CutoverPhase,
  DELIVERY_CUTOVER_DRAINING,
  DELIVERY_CUTOVER_LEGACY_BLOCKED,
  LegacyDeliveryEntryPoint,
} from '../interface/legacy.delivery.entry.point';

/**
 * 컷오버 전환 마크 기반 legacy 진입 거부 계약.
 * plans/프리미엄_발송실패_재발송_구상.md §9 「기존 경로 컷오버·마이그레이션 계약」.
 */
describe('DeliveryCutoverGuardService — 전환 건 legacy 진입 거부', () => {
  const createService = (options: { cutoverIds?: number[]; drainingIds?: number[]; findError?: Error } = {}) => {
    const calls: unknown[] = [];
    const repository = {
      find: jest.fn().mockImplementation(async (opts: { where: { orderDeliveryId: unknown }[] }) => {
        calls.push(opts);
        if (options.findError) {
          throw options.findError;
        }
        // where 는 OR 배열(migrated 또는 draining)이며, In(...) 값은 FindOperator.value 에 담긴다.
        const first = Array.isArray(opts.where) ? opts.where[0] : (opts.where as { orderDeliveryId: unknown });
        const operator = first.orderDeliveryId as { value?: number[] };
        const requested: number[] = Array.isArray(operator?.value) ? operator.value : [];
        const migrated = (options.cutoverIds ?? [])
          .filter((id) => requested.includes(id))
          .map((id) => ({ orderDeliveryId: id, cutoverMigratedAt: new Date(), cutoverDrainingAt: new Date() }));
        const draining = (options.drainingIds ?? [])
          .filter((id) => requested.includes(id))
          .map((id) => ({ orderDeliveryId: id, cutoverMigratedAt: null, cutoverDrainingAt: new Date() }));
        return [...migrated, ...draining];
      }),
    } as never;

    const refundAttemptRepository = { findOne: jest.fn() } as never;
    return { service: new DeliveryCutoverGuardService(repository, refundAttemptRepository), calls };
  };

  describe('미전환 건은 기존 경로를 그대로 쓴다', () => {
    it('workflow 행이 없으면 통과한다', async () => {
      const { service } = createService();
      await expect(
        service.assertLegacyAllowed(1234, LegacyDeliveryEntryPoint.FAILURE_LIST_RESEND),
      ).resolves.toBeUndefined();
    });

    it('workflow 행이 있어도 cutover_migrated_at 이 NULL 이면 통과한다', async () => {
      // 전환 마크가 없는 행은 조회 결과에 포함되지 않는다(WHERE cutoverMigratedAt IS NOT NULL).
      const { service } = createService({ cutoverIds: [] });
      await expect(service.assertLegacyAllowed(1234, LegacyDeliveryEntryPoint.BATCH_SEND)).resolves.toBeUndefined();
    });
  });

  describe('전환 건은 모든 legacy 진입점에서 거부된다', () => {
    it.each(Object.values(LegacyDeliveryEntryPoint))('%s 진입은 409 로 거부한다', async (entryPoint) => {
      const { service } = createService({ cutoverIds: [1234] });

      await expect(service.assertLegacyAllowed(1234, entryPoint)).rejects.toBeInstanceOf(ConflictException);
    });

    it('거부 응답에 코드·진입점·대상 id 를 담는다', async () => {
      const { service } = createService({ cutoverIds: [1234] });

      const error = await service.assertLegacyAllowed(1234, LegacyDeliveryEntryPoint.CS_RESEND).catch((e) => e);

      expect(error).toBeInstanceOf(ConflictException);
      const body = (error as ConflictException).getResponse() as Record<string, unknown>;
      expect(body.code).toBe(DELIVERY_CUTOVER_LEGACY_BLOCKED);
      expect(body.entryPoint).toBe(LegacyDeliveryEntryPoint.CS_RESEND);
      expect(body.orderDeliveryIds).toEqual([1234]);
    });

    it('환불 진입점도 예외 없이 거부한다(§9 환불 컷오버 — refund_attempt 단일 실행 주체)', async () => {
      const { service } = createService({ cutoverIds: [77] });

      await expect(
        service.assertLegacyAllowed(77, LegacyDeliveryEntryPoint.BATCH_REFUND_FOR_FAIL),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        service.assertLegacyAllowed(77, LegacyDeliveryEntryPoint.REFUND_LEDGER_CLAIM),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('조회 실패는 fail-closed 다', () => {
    it('전환 여부를 확인하지 못하면 통과시키지 않고 오류를 전파한다', async () => {
      const { service } = createService({ findError: new Error('db down') });

      await expect(service.assertLegacyAllowed(1234, LegacyDeliveryEntryPoint.BATCH_SEND)).rejects.toThrow('db down');
    });
  });

  describe('배치용 일괄 판정', () => {
    it('전환 건만 걸러내고 나머지는 legacy 로 계속 처리한다', async () => {
      const { service } = createService({ cutoverIds: [2, 4] });

      const result = await service.splitLegacyAllowed([1, 2, 3, 4, 5]);

      expect(result.allowed).toEqual([1, 3, 5]);
      expect(result.blocked).toEqual([2, 4]);
    });

    it('빈 목록은 조회하지 않는다', async () => {
      const { service, calls } = createService();

      const result = await service.splitLegacyAllowed([]);

      expect(result).toEqual({ allowed: [], blocked: [] });
      expect(calls).toHaveLength(0);
    });

    it('중복 id 는 한 번만 조회한다', async () => {
      const { service, calls } = createService({ cutoverIds: [9] });

      const result = await service.splitLegacyAllowed([9, 9, 8]);

      expect(result.allowed).toEqual([8]);
      expect(result.blocked).toEqual([9]);
      expect(calls).toHaveLength(1);
    });
  });

  describe('isCutover — 발송 모델 라우팅', () => {
    it('전환 건이면 true, 미전환이면 false 다', async () => {
      const { service } = createService({ cutoverIds: [5] });

      await expect(service.isCutover(5)).resolves.toBe(true);
      await expect(service.isCutover(6)).resolves.toBe(false);
    });

    it('드레이닝 중이면 어느 모델도 시작하지 않고 거부한다', async () => {
      // boolean 으로 답하면 둘 중 하나를 시작하게 된다. quiesce 는 "양쪽 모두 정지"라 던져야 한다.
      const { service } = createService({ drainingIds: [7] });

      const error = await service.isCutover(7).catch((e) => e);

      expect(error).toBeInstanceOf(ConflictException);
      const body = (error as ConflictException).getResponse() as Record<string, unknown>;
      expect(body.code).toBe(DELIVERY_CUTOVER_DRAINING);
      expect(body.phase).toBe(CutoverPhase.DRAINING);
    });
  });

  describe('드레이닝(quiesce) — admission race 차단', () => {
    it('드레이닝 건은 legacy 신규 진입을 거부한다(전환 마크 전이라도)', async () => {
      // 드레이닝 확인과 전환 사이에 legacy 가 새로 들어오는 창을 닫는 것이 이 마크의 존재 이유다.
      const { service } = createService({ drainingIds: [11] });

      const error = await service
        .assertLegacyAllowed(11, LegacyDeliveryEntryPoint.CS_RESEND)
        .then(() => null)
        .catch((e) => e);

      expect(error).toBeInstanceOf(ConflictException);
      const body = (error as ConflictException).getResponse() as Record<string, unknown>;
      expect(body.code).toBe(DELIVERY_CUTOVER_LEGACY_BLOCKED);
      expect(body.phase).toBe(CutoverPhase.DRAINING);
    });

    it('일괄 판정에서도 드레이닝 건을 legacy 대상에서 뺀다', async () => {
      const { service } = createService({ cutoverIds: [2], drainingIds: [4] });

      const result = await service.splitLegacyAllowed([1, 2, 3, 4, 5]);

      expect(result.allowed).toEqual([1, 3, 5]);
      expect(result.blocked.sort()).toEqual([2, 4]);
    });
  });

  describe('assertRefundExecutionAllowed — 환불 실행 게이트(§9 #12·§6.1 3중 fencing)', () => {
    const orderDeliveryId = 1234;
    const entryPoint = LegacyDeliveryEntryPoint.REFUND_LEDGER_CLAIM;
    const now = new Date('2026-07-28T12:00:00+09:00');

    /** 정상 실행자가 제시하는 fencing. BIGINT 컬럼과 대조되므로 전부 string 이다. */
    const fencing: RefundExecutionFencing = {
      refundAttemptId: '9007199254740993', // 2^53 초과 — number 로 다루면 정밀도가 깨지는 값
      ownerToken: 'owner-token-1',
      generation: '3',
      workflowVersion: '9',
    };

    /**
     * 권위 판정은 **조인 쿼리 1회**(`getCount`)다. 그 쿼리가 0을 돌려줄 때만 원인 진단 조회가 돈다.
     * 여기서는 조인 쿼리의 WHERE 파라미터를 그대로 캡처해 fencing 조건이 실제로 실렸는지도 검증한다.
     */
    const createRefundService = (options: {
      cutover?: boolean;
      matched?: boolean;
      activeExclusiveOp?: string | null;
      leaseMs?: number | null;
      attempt?: Record<string, unknown> | null;
    }) => {
      const conditions: { sql: string; params?: Record<string, unknown> }[] = [];
      const qb: any = {
        innerJoin: jest.fn(() => qb),
        where: jest.fn((sql: string, params?: Record<string, unknown>) => {
          conditions.push({ sql, params });
          return qb;
        }),
        andWhere: jest.fn((sql: string, params?: Record<string, unknown>) => {
          conditions.push({ sql, params });
          return qb;
        }),
        getCount: jest.fn().mockResolvedValue(options.matched === false ? 0 : 1),
      };

      const workflowRepository = {
        findOne: jest.fn().mockResolvedValue({
          orderDeliveryId,
          cutoverMigratedAt: options.cutover === false ? null : new Date('2026-07-28T00:00:00+09:00'),
          activeExclusiveOp: options.activeExclusiveOp === undefined ? 'REFUND' : options.activeExclusiveOp,
          exclusiveLeaseExpiresAt:
            options.leaseMs === null ? null : new Date(now.getTime() + (options.leaseMs ?? 60_000)),
        }),
        createQueryBuilder: jest.fn(() => qb),
      } as never;

      const refundAttemptRepository = {
        findOne: jest.fn().mockResolvedValue(
          options.attempt === undefined
            ? { id: fencing.refundAttemptId, orderDeliveryId, status: 'SUBMITTING' }
            : options.attempt,
        ),
      } as never;

      return {
        service: new DeliveryCutoverGuardService(workflowRepository, refundAttemptRepository),
        conditions,
        qb,
      };
    };

    const reasonOf = async (
      service: DeliveryCutoverGuardService,
      override?: Partial<RefundExecutionFencing> | null,
    ) => {
      const error = await service
        .assertRefundExecutionAllowed({
          orderDeliveryId,
          entryPoint,
          now,
          fencing: override === null ? null : { ...fencing, ...override },
        })
        .then(() => null)
        .catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      return ((error as ConflictException).getResponse() as Record<string, unknown>).reason;
    };

    it('미전환 건은 검사하지 않는다(기존 경로 그대로)', async () => {
      const { service, qb } = createRefundService({ cutover: false });

      await expect(service.assertRefundExecutionAllowed({ orderDeliveryId, entryPoint })).resolves.toBeUndefined();
      expect(qb.getCount).not.toHaveBeenCalled();
    });

    it('fencing 없는 직접 호출은 거부한다', async () => {
      const { service } = createRefundService({});

      expect(await reasonOf(service, null)).toBe('REFUND_EXECUTION_FENCING_REQUIRED');
    });

    it('드레이닝 중에는 legacy·신규 환불 모두 시작하지 않는다', async () => {
      const workflowRepository = {
        findOne: jest.fn().mockResolvedValue({
          orderDeliveryId,
          cutoverDrainingAt: new Date('2026-07-28T00:00:00+09:00'),
          cutoverMigratedAt: null,
          activeExclusiveOp: 'REFUND',
          exclusiveLeaseExpiresAt: new Date(now.getTime() + 60_000),
        }),
        createQueryBuilder: jest.fn(),
      } as never;
      const service = new DeliveryCutoverGuardService(workflowRepository, { findOne: jest.fn() } as never);

      expect(await reasonOf(service)).toBe('CUTOVER_DRAINING');
    });

    it('fencing 값이 하나라도 비면 거부한다(부분 제시 금지)', async () => {
      for (const missing of ['refundAttemptId', 'ownerToken', 'generation', 'workflowVersion'] as const) {
        const { service } = createRefundService({});
        expect(await reasonOf(service, { [missing]: '' })).toBe('REFUND_EXECUTION_FENCING_REQUIRED');
      }
    });

    it('권위 판정은 조인 쿼리 1회이며 3중 fencing 이 모두 WHERE 에 실린다', async () => {
      const { service, conditions, qb } = createRefundService({});

      await service.assertRefundExecutionAllowed({ orderDeliveryId, entryPoint, now, fencing });

      const sql = conditions.map((c) => c.sql).join(' | ');
      // workflow 쪽 — 슬롯 op·lease·소유자 토큰·세대(workflow_version)
      expect(sql).toContain('w.active_exclusive_op = :refundOp');
      expect(sql).toContain('w.exclusive_lease_expires_at > :now');
      expect(sql).toContain('w.exclusive_owner_token = :ownerToken');
      expect(sql).toContain('w.workflow_version = :workflowVersion');
      // attempt 쪽 — 소유·실행 상태·같은 소유자/세대
      expect(sql).toContain('ra.id = :refundAttemptId');
      expect(sql).toContain('ra.status IN (:...executing)');
      expect(sql).toContain('ra.owner_token = :ownerToken');
      expect(sql).toContain('ra.generation = :generation');
      expect(sql).toContain('ra.workflow_version = :workflowVersion');
      expect(qb.getCount).toHaveBeenCalledTimes(1);

      const params = Object.assign({}, ...conditions.map((c) => c.params ?? {}));
      // 문자열 그대로 실려야 한다 — number 로 변환되면 2^53 초과 id 가 다른 행과 대조된다.
      expect(params.refundAttemptId).toBe('9007199254740993');
      expect(params.ownerToken).toBe('owner-token-1');
      expect(params.generation).toBe('3');
      expect(params.workflowVersion).toBe('9');
    });

    it('lease 를 뺏긴 stale worker 는 fencing 불일치로 거부된다', async () => {
      // 조인은 0건이지만 슬롯·attempt 자체는 정상 상태 → 남은 원인은 fencing 불일치뿐이다.
      const { service } = createRefundService({ matched: false });

      expect(await reasonOf(service, { ownerToken: 'stale-token' })).toBe('REFUND_FENCING_MISMATCH');
    });

    it('존재하지 않거나 다른 발송건 소유의 attempt 는 거부한다', async () => {
      expect(await reasonOf(createRefundService({ matched: false, attempt: null }).service)).toBe(
        'REFUND_ATTEMPT_NOT_OWNED',
      );
      expect(
        await reasonOf(
          createRefundService({
            matched: false,
            attempt: { id: fencing.refundAttemptId, orderDeliveryId: 9999, status: 'SUBMITTING' },
          }).service,
        ),
      ).toBe('REFUND_ATTEMPT_NOT_OWNED');
    });

    it('실행 중이 아닌 attempt(RECONCILING·UNKNOWN·터미널)로는 통과하지 못한다', async () => {
      for (const status of ['RECONCILING', 'UNKNOWN', 'SUCCEEDED', 'FAILED']) {
        const { service } = createRefundService({
          matched: false,
          attempt: { id: fencing.refundAttemptId, orderDeliveryId, status },
        });
        expect(await reasonOf(service)).toBe('REFUND_ATTEMPT_NOT_EXECUTING');
      }
    });

    it('REFUND 슬롯이 없거나 lease 가 만료됐으면 거부한다', async () => {
      expect(await reasonOf(createRefundService({ matched: false, activeExclusiveOp: null }).service)).toBe(
        'REFUND_SLOT_NOT_HELD',
      );
      expect(
        await reasonOf(createRefundService({ matched: false, activeExclusiveOp: 'MANUAL_RESEND' }).service),
      ).toBe('REFUND_SLOT_NOT_HELD');
      expect(await reasonOf(createRefundService({ matched: false, leaseMs: -1_000 }).service)).toBe(
        'REFUND_SLOT_NOT_HELD',
      );
      expect(await reasonOf(createRefundService({ matched: false, leaseMs: null }).service)).toBe(
        'REFUND_SLOT_NOT_HELD',
      );
    });

    it('소유·실행 상태·슬롯·3중 fencing 이 모두 맞을 때만 통과한다', async () => {
      const { service } = createRefundService({});

      await expect(
        service.assertRefundExecutionAllowed({ orderDeliveryId, entryPoint, now, fencing }),
      ).resolves.toBeUndefined();
    });
  });
});
