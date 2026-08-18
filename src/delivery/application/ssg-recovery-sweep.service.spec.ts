import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderDeliveryRefundEntity } from '../../entity/order.delivery.refund.entity';
import { PinIssueCommandEntity } from '../../entity/pin.issue.command.entity';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { SsgRecoveryResult } from '../interface/ssg.recovery.result';
import { SsgRecoverySweepService } from './ssg-recovery-sweep.service';
import { PinIssueCommandService } from './pin-issue-command.service';
import { SsgRecoveryService } from './ssg-recovery.service';
import { SsgAutoResolveConfig } from '../../partner_company_extern/application/ssg.autoresolve.config';
import { SSG_AUTORESOLVE_PHASE } from '../../partner_company_extern/domain/ssg.autoresolve.policy';
import { PinIssueCommandStatus } from '../interface/pin.issue.command.status';
import { DeliveryCutoverGuardService } from './delivery-cutover-guard.service';

/**
 * SsgRecoverySweepService 단위 테스트
 * docs/plans/2026-06-12-external-api-wallet-integration.md B-7.
 *
 * 검증 범위:
 *  - 후보 쿼리 WHERE: settled=false AND lease 만료/NULL AND refunded_at >= migrationAt (시간 격리)
 *  - 각 후보 → recoverWithLease 호출 (refundAmount = order.sendAmount 스냅샷)
 *  - 후보 처리 예외는 흡수 후 다음 후보 진행
 */
describe('SsgRecoverySweepService', () => {
  let sut: SsgRecoverySweepService;
  let refundRepository: { createQueryBuilder: jest.Mock };
  let recoveryService: { recoverWithLease: jest.Mock };
  let qb: any;
  const origEnv = process.env.SSG_SWEEP_MIGRATION_AT;

  const makeQb = (rawRows: any[]) => {
    const chain: any = {
      innerJoin: jest.fn(() => chain),
      select: jest.fn(() => chain),
      addSelect: jest.fn(() => chain),
      where: jest.fn(() => chain),
      andWhere: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      getRawMany: jest.fn(() => Promise.resolve(rawRows)),
    };
    return chain;
  };

  const setup = async (rawRows: any[]) => {
    qb = makeQb(rawRows);
    refundRepository = { createQueryBuilder: jest.fn(() => qb) };
    recoveryService = {
      recoverWithLease: jest.fn().mockResolvedValue(SsgRecoveryResult.RESTORED),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: DeliveryCutoverGuardService,
          useValue: {
            // §9 컷오버 게이트 — 단위 테스트 기본값은 '미전환 건'(legacy 경로 그대로 통과).
            assertLegacyAllowed: jest.fn().mockResolvedValue(undefined),
            assertRefundExecutionAllowed: jest.fn().mockResolvedValue(undefined),
            isCutover: jest.fn().mockResolvedValue(false),
            splitLegacyAllowed: jest.fn(async (ids: number[]) => ({ allowed: ids, blocked: [] })),
          },
        },
        SsgRecoverySweepService,
        { provide: getRepositoryToken(OrderDeliveryRefundEntity), useValue: refundRepository },
        { provide: getRepositoryToken(PinIssueCommandEntity), useValue: { createQueryBuilder: jest.fn() } },
        { provide: getRepositoryToken(OrderDeliveryEntity), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(SsgEventEntity), useValue: { findOne: jest.fn() } },
        { provide: SsgRecoveryService, useValue: recoveryService },
        {
          provide: PinIssueCommandService,
          useValue: {
            recordResolution: jest.fn(),
            consumeNotIssuedRetryAuthority: jest.fn(),
            markSucceeded: jest.fn().mockResolvedValue(true),
          },
        },
        { provide: PartnerCompanyExternService, useValue: { resolveDeferredSsgIssue: jest.fn(), issue: jest.fn() } },
        { provide: SsgAutoResolveConfig, useValue: new SsgAutoResolveConfig({ get: () => 'off' } as any) },
      ],
    }).compile();
    sut = module.get(SsgRecoverySweepService);
  };

  afterEach(() => {
    jest.clearAllMocks();
    if (origEnv === undefined) delete process.env.SSG_SWEEP_MIGRATION_AT;
    else process.env.SSG_SWEEP_MIGRATION_AT = origEnv;
  });

  it('후보 쿼리: settled=false + lease 만료/NULL + refunded_at >= migrationAt(시간 격리)', async () => {
    process.env.SSG_SWEEP_MIGRATION_AT = '2026-06-12T00:00:00.000Z';
    await setup([]);

    await sut.sweepOnce();

    const whereCalls = [
      ...qb.where.mock.calls.map((c: any[]) => c[0]),
      ...qb.andWhere.mock.calls.map((c: any[]) => c[0]),
    ].join(' | ');
    expect(whereCalls).toContain('r.ssg_balance_settled = false');
    expect(whereCalls).toContain('r.ssg_recover_lease_until IS NULL OR r.ssg_recover_lease_until < NOW(6)');
    expect(whereCalls).toContain('r.refunded_at >= :migrationAt');

    // migrationAt 파라미터가 env 값으로 바인딩됐는지 확인
    const migAtCall = qb.andWhere.mock.calls.find((c: any[]) => c[0] === 'r.refunded_at >= :migrationAt');
    expect(migAtCall[1].migrationAt).toEqual(new Date('2026-06-12T00:00:00.000Z'));
  });

  it('각 후보 → recoverWithLease 호출 (refundAmount = order.sendAmount)', async () => {
    process.env.SSG_SWEEP_MIGRATION_AT = '2020-01-01T00:00:00.000Z';
    await setup([
      { orderDeliveryId: 11, ssgEventId: 36, orderId: 4145, refundAmount: 10000 },
      { orderDeliveryId: 22, ssgEventId: 37, orderId: 4146, refundAmount: 5000 },
    ]);

    const stats = await sut.sweepOnce();

    expect(recoveryService.recoverWithLease).toHaveBeenCalledTimes(2);
    expect(recoveryService.recoverWithLease).toHaveBeenNthCalledWith(1, 11, 36, 4145, 10000);
    expect(recoveryService.recoverWithLease).toHaveBeenNthCalledWith(2, 22, 37, 4146, 5000);
    expect(stats.candidates).toBe(2);
    expect(stats.restored).toBe(2);
  });

  it('SSG_SWEEP_MIGRATION_AT 미설정 → sweep 중단 (후보 조회/recoverWithLease 미호출, new Date() fallback 금지)', async () => {
    delete process.env.SSG_SWEEP_MIGRATION_AT;
    await setup([{ orderDeliveryId: 11, ssgEventId: 36, orderId: 4145, refundAmount: 10000 }]);

    const stats = await sut.sweepOnce();

    expect(refundRepository.createQueryBuilder).not.toHaveBeenCalled();
    expect(recoveryService.recoverWithLease).not.toHaveBeenCalled();
    expect(stats).toEqual({ candidates: 0, restored: 0, deferred: 0, skipped: 0 });
  });

  it('SSG_SWEEP_MIGRATION_AT 파싱실패 → sweep 중단', async () => {
    process.env.SSG_SWEEP_MIGRATION_AT = 'not-a-date';
    await setup([{ orderDeliveryId: 11, ssgEventId: 36, orderId: 4145, refundAmount: 10000 }]);

    const stats = await sut.sweepOnce();

    expect(recoveryService.recoverWithLease).not.toHaveBeenCalled();
    expect(stats.candidates).toBe(0);
  });

  it('후보 처리 예외는 흡수 후 다음 후보 진행', async () => {
    process.env.SSG_SWEEP_MIGRATION_AT = '2020-01-01T00:00:00.000Z';
    await setup([
      { orderDeliveryId: 11, ssgEventId: 36, orderId: 4145, refundAmount: 10000 },
      { orderDeliveryId: 22, ssgEventId: 37, orderId: 4146, refundAmount: 5000 },
    ]);
    recoveryService.recoverWithLease
      .mockRejectedValueOnce(new Error('infra boom'))
      .mockResolvedValueOnce(SsgRecoveryResult.RESTORED);

    const stats = await sut.sweepOnce();

    expect(recoveryService.recoverWithLease).toHaveBeenCalledTimes(2);
    expect(stats.candidates).toBe(2);
    expect(stats.skipped).toBe(1);
    expect(stats.restored).toBe(1);
  });
});
describe('P24 PIN resolution sweep fencing', () => {
  const candidate = (overrides: Record<string, unknown> = {}) =>
    ({
      id: '91',
      orderDeliveryId: 71,
      ownerToken: 'dead-worker',
      generation: '4',
      workflowVersion: '9',
      status: 'RETRY_PENDING',
      resolution: 'PROCESSING',
      externalIssueCount: 1,
      resolutionLookupCount: 0,
      resolutionStartedAt: new Date(),
      ...overrides,
    }) as any;

  const query = (execute = jest.fn().mockResolvedValue({ affected: 1 }), rows: any[] = []) => {
    const qb: any = {
      where: jest.fn(() => qb),
      andWhere: jest.fn(() => qb),
      orderBy: jest.fn(() => qb),
      limit: jest.fn(() => qb),
      update: jest.fn(() => qb),
      set: jest.fn(() => qb),
      execute,
      getMany: jest.fn().mockResolvedValue(rows),
    };
    return qb;
  };

  // command 회수는 이제 repository.manager(비-batch) 또는 manager.transaction(batch) 로 흐르고,
  // findDuePinCommands 만 aliased repository.createQueryBuilder 를 쓴다. 한 트랜잭션 안에서는 첫
  // createQueryBuilder 가 delivery 갱신, 그 다음이 command 회수 CAS 다.
  const sweepRepo = (opts: { finder?: any; command: any; deliveryRefresh?: any; direct?: any }) => {
    const { finder, command, deliveryRefresh = query(), direct = command } = opts;
    // 실제 TypeORM transaction 처럼 callback 예외 시 rollback 하고 예외를 전파한다. rolledBack 으로
    // "command CAS 실패 → delivery UPDATE rollback" 원자성 계약을 단위에서 검증한다.
    const tx = { rolledBack: false, committed: false };
    return {
      // aliased = findDuePinCommands; no-alias = promoteOpsReview (repository.createQueryBuilder 직접).
      createQueryBuilder: jest.fn((alias?: string) => (alias ? finder : direct)),
      tx,
      manager: {
        createQueryBuilder: jest.fn(() => command),
        transaction: jest.fn(async (cb: (m: any) => Promise<unknown>) => {
          let deliveryServed = false;
          const manager = {
            createQueryBuilder: jest.fn(() => {
              if (!deliveryServed) {
                deliveryServed = true;
                return deliveryRefresh;
              }
              return command;
            }),
          };
          try {
            const result = await cb(manager);
            tx.committed = true;
            return result;
          } catch (error) {
            tx.rolledBack = true;
            throw error;
          }
        }),
      },
    };
  };

  const makeService = (
    repo: any,
    opts: { delivery?: any; ssgEvent?: any; pinCmd?: any; partner?: any; autoResolveMode?: string } = {},
  ): any =>
    new SsgRecoverySweepService(
      {} as any,
      repo as any,
      (opts.delivery ?? { findOne: jest.fn() }) as any,
      (opts.ssgEvent ?? { findOne: jest.fn() }) as any,
      {} as any,
      (opts.pinCmd ?? {}) as any,
      (opts.partner ?? {}) as any,
      new SsgAutoResolveConfig({
        get: () => opts.autoResolveMode ?? 'off',
      } as any),
    );

  const ISO = '2026-08-11T00:00:00.000Z';

  it('concurrent workers have one CAS winner and the stale candidate cannot lookup', async () => {
    const command = query(jest.fn().mockResolvedValueOnce({ affected: 1 }).mockResolvedValue({ affected: 0 }));
    const finder = query(undefined, [candidate()]);
    const repo = sweepRepo({ finder, command });
    const resolve = jest.fn().mockResolvedValue('PROCESSING');
    const service = makeService(repo, {
      delivery: { findOne: jest.fn().mockResolvedValue({ id: 71 }) },
      pinCmd: { recordResolution: jest.fn().mockResolvedValue(true), consumeNotIssuedRetryAuthority: jest.fn() },
      partner: { resolveDeferredSsgIssue: resolve },
    });

    await service.resolvePinIssuesOnce();
    await service.resolvePinIssuesOnce();

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(command.execute).toHaveBeenCalledTimes(2);
  });

  it('reclaims a crashed PROCESSING lease and rotates the fence', async () => {
    const command = query();
    const service = makeService(sweepRepo({ command }));

    await service.claimPinCommand(candidate({ status: 'RETRYING' }), new Date());

    expect(command.set).toHaveBeenCalledWith(expect.objectContaining({ generation: '5' }));
    expect(command.andWhere.mock.calls.map((call: any[]) => call[0]).join(' ')).toContain('lease_expires_at < :now');
  });

  it('does not let an unrelated expired RETRYING row bypass the candidate fence', async () => {
    const command = query();
    const service = makeService(sweepRepo({ command }));

    await service.claimPinCommand(candidate({ id: 'target-command' }), new Date());

    expect(command.where).toHaveBeenCalledWith('id = :id', { id: 'target-command' });
    expect(command.andWhere).toHaveBeenCalledWith('owner_token = :previousOwnerToken', {
      previousOwnerToken: 'dead-worker',
    });
    expect(command.andWhere).toHaveBeenCalledWith('generation = :previousGeneration', {
      previousGeneration: '4',
    });
    expect(command.andWhere).toHaveBeenCalledWith('workflow_version = :workflowVersion', {
      workflowVersion: '9',
    });
    const eligibility = command.andWhere.mock.calls
      .find((call: any[]) => String(call[0]).includes(':retryPending'))[0]
      .trim();
    expect(eligibility).toMatch(/^\([\s\S]*\)$/);
    expect(eligibility).toContain('status = :retrying');
  });

  it('escalates before a seventh lookup', async () => {
    const command = query();
    const promote = query();
    const finder = query(undefined, [candidate({ resolutionLookupCount: 6 })]);
    const resolve = jest.fn();
    const service = makeService(sweepRepo({ finder, command, direct: promote }), {
      delivery: { findOne: jest.fn().mockResolvedValue({ id: 71 }) },
      pinCmd: { recordResolution: jest.fn(), consumeNotIssuedRetryAuthority: jest.fn() },
      partner: { resolveDeferredSsgIssue: resolve },
    });

    await service.resolvePinIssuesOnce();

    expect(resolve).not.toHaveBeenCalled();
    expect(promote.execute).toHaveBeenCalled();
  });

  it('replays expired count-2 NOT_ISSUED through resolver only, without another INSERT', async () => {
    const command = query();
    const record = jest.fn().mockResolvedValue(true);
    const finder = query(undefined, [candidate({ externalIssueCount: 2, resolution: 'NOT_ISSUED' })]);
    const resolve = jest.fn().mockResolvedValue('NOT_ISSUED');
    const issue = jest.fn();
    const service = makeService(sweepRepo({ finder, command }), {
      delivery: { findOne: jest.fn().mockResolvedValue({ id: 71, ssgEventId: 42 }) },
      ssgEvent: { findOne: jest.fn().mockResolvedValue({ id: 42 }) },
      pinCmd: { recordResolution: record, consumeNotIssuedRetryAuthority: jest.fn(), markSucceeded: jest.fn() },
      partner: { resolveDeferredSsgIssue: resolve, issue },
    });

    await service.resolvePinIssuesOnce();
    await service.resolvePinIssuesOnce();

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(issue).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ resolution: 'NOT_ISSUED', status: 'OPS_REVIEW_REQUIRED' }),
    );
  });

  // HIGH 1: batch 명령 회수는 한 트랜잭션에서 delivery mutation claim 을 새 ISO 토큰으로 갱신하고
  // command 의 delivery_claim_token 도 함께 rotate 해야 한다. 이후 발급·완료는 rotate 된 토큰으로만.
  it('refreshes the delivery mutation claim and rotates the token when reclaiming a batch command', async () => {
    const command = query();
    const deliveryRefresh = query();
    const finder = query(undefined, [
      candidate({
        deliveryClaimToken: '2026-08-03T01:00:00.000Z',
        status: 'STARTED',
        externalIssueCount: 1,
        resolution: null,
      }),
    ]);
    const markSucceededAfterDeliveryClaimRelease = jest.fn().mockResolvedValue(true);
    const service = makeService(sweepRepo({ finder, command, deliveryRefresh }), {
      delivery: { findOne: jest.fn().mockResolvedValue({ id: 71 }) },
      pinCmd: {
        recordResolution: jest.fn(),
        consumeNotIssuedRetryAuthority: jest.fn(),
        markSucceededAfterDeliveryClaimRelease,
      },
      partner: { resolveDeferredSsgIssue: jest.fn().mockResolvedValue('CONFIRMED'), issue: jest.fn() },
    });

    const stats = await service.resolvePinIssuesOnce();

    expect(deliveryRefresh.set).toHaveBeenCalledWith(
      expect.objectContaining({ claimedAt: expect.any(Date), mutationClaimedAt: expect.any(Date) }),
    );
    const deliveryPredicates = deliveryRefresh.andWhere.mock.calls.map((call: any[]) => call[0]);
    expect(deliveryPredicates).toEqual(
      expect.arrayContaining([
        'status = :wait',
        'claimed_at = :prior',
        'mutation_claimed_at = :prior',
        'destroyed_at IS NULL',
        'discarded_at IS NULL',
        'refunded_at IS NULL',
      ]),
    );
    const rotated = command.set.mock.calls[0][0].deliveryClaimToken;
    expect(rotated).toEqual(expect.any(String));
    expect(rotated).not.toBe('2026-08-03T01:00:00.000Z');
    expect(markSucceededAfterDeliveryClaimRelease).toHaveBeenCalledWith(expect.any(Object), 71, rotated);
    expect(stats.confirmed).toBe(1);
  });

  it('does not issue when the expired delivery claim was stolen (refresh CAS fails)', async () => {
    const command = query();
    const deliveryRefresh = query(jest.fn().mockResolvedValue({ affected: 0 }));
    const finder = query(undefined, [
      candidate({
        deliveryClaimToken: '2026-08-03T01:00:00.000Z',
        status: 'STARTED',
        externalIssueCount: 0,
        resolution: null,
      }),
    ]);
    const consumeInitialIssueAuthority = jest.fn().mockResolvedValue(true);
    const issue = jest.fn();
    const service = makeService(sweepRepo({ finder, command, deliveryRefresh }), {
      delivery: { findOne: jest.fn().mockResolvedValue({ id: 71, ssgEventId: null }) },
      pinCmd: { consumeInitialIssueAuthority, consumeNotIssuedRetryAuthority: jest.fn(), recordResolution: jest.fn() },
      partner: { resolveDeferredSsgIssue: jest.fn(), issue },
    });

    const stats = await service.resolvePinIssuesOnce();

    expect(command.execute).not.toHaveBeenCalled();
    expect(consumeInitialIssueAuthority).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
    expect(stats.skipped).toBe(1);
  });

  it('rolls back the delivery refresh when the command reclaim CAS loses', async () => {
    const command = query(jest.fn().mockResolvedValue({ affected: 0 }));
    const deliveryRefresh = query();
    const finder = query(undefined, [
      candidate({
        deliveryClaimToken: '2026-08-03T01:00:00.000Z',
        status: 'STARTED',
        externalIssueCount: 0,
        resolution: null,
      }),
    ]);
    const consumeInitialIssueAuthority = jest.fn().mockResolvedValue(true);
    const issue = jest.fn();
    const repo = sweepRepo({ finder, command, deliveryRefresh });
    const service = makeService(repo, {
      delivery: { findOne: jest.fn().mockResolvedValue({ id: 71, ssgEventId: null }) },
      pinCmd: { consumeInitialIssueAuthority, consumeNotIssuedRetryAuthority: jest.fn(), recordResolution: jest.fn() },
      partner: { resolveDeferredSsgIssue: jest.fn(), issue },
    });

    const stats = await service.resolvePinIssuesOnce();

    // 트랜잭션 callback 이 command CAS 실패로 throw → 전파(rollback) 되었고 commit 되지 않았다.
    expect(deliveryRefresh.execute).toHaveBeenCalledTimes(1);
    expect(repo.tx.rolledBack).toBe(true);
    expect(repo.tx.committed).toBe(false);
    expect(consumeInitialIssueAuthority).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
    expect(stats.skipped).toBe(1);
  });

  // HIGH: sweep 시작 now 를 100개 후보 전체에 재사용하면, 앞 후보가 5분 넘게 걸릴 때 뒤 후보의
  // lease/rotate 토큰이 claim 순간 이미 만료돼 fencing 이 깨진다. 후보마다 claim 시점의 새 시각을 써야 한다.
  it('claims each candidate with a fresh timestamp, never reusing the sweep-start time', async () => {
    const finder = query(undefined, [candidate({ id: 'a' }), candidate({ id: 'b' })]);
    const service = makeService(sweepRepo({ finder, command: query() }));
    const findSpy = jest.spyOn(service, 'findDuePinCommands');
    const claimSpy = jest.spyOn(service, 'claimPinCommand').mockResolvedValue(null);

    await service.resolvePinIssuesOnce();

    const sweepNow = findSpy.mock.calls[0][0];
    expect(claimSpy).toHaveBeenCalledTimes(2);
    const t0 = claimSpy.mock.calls[0][1];
    const t1 = claimSpy.mock.calls[1][1];
    expect(t0).not.toBe(sweepNow);
    expect(t1).not.toBe(sweepNow);
    expect(t1).not.toBe(t0);
  });

  it('completes the initial INSERT for a reclaimed batch count-0 STARTED command', async () => {
    const command = query();
    const deliveryRefresh = query();
    const finder = query(undefined, [
      candidate({ status: 'STARTED', externalIssueCount: 0, resolution: null, deliveryClaimToken: ISO }),
    ]);
    const consumeInitialIssueAuthority = jest.fn().mockResolvedValue(true);
    const markSucceededAfterDeliveryClaimRelease = jest.fn().mockResolvedValue(true);
    const resolve = jest.fn();
    const issue = jest.fn();
    const service = makeService(sweepRepo({ finder, command, deliveryRefresh }), {
      delivery: { findOne: jest.fn().mockResolvedValue({ id: 71, ssgEventId: null }) },
      pinCmd: {
        consumeInitialIssueAuthority,
        consumeNotIssuedRetryAuthority: jest.fn(),
        recordResolution: jest.fn(),
        markSucceededAfterDeliveryClaimRelease,
      },
      partner: { resolveDeferredSsgIssue: resolve, issue },
    });

    const stats = await service.resolvePinIssuesOnce();

    expect(resolve).not.toHaveBeenCalled();
    expect(consumeInitialIssueAuthority).toHaveBeenCalledTimes(1);
    expect(issue).toHaveBeenCalledTimes(1);
    const rotated = command.set.mock.calls[0][0].deliveryClaimToken;
    expect(markSucceededAfterDeliveryClaimRelease).toHaveBeenCalledWith(expect.any(Object), 71, rotated);
    expect(stats.confirmed).toBe(1);
  });

  /**
   * EP-P30 §6-B-3 — 판정기가 `tryYn='N'` 을 NOT_ISSUED 로 반환하기 시작하면 이 경로가 살아난다.
   * 게이트(SSG_AUTORESOLVE_PHASE.ORDINAL_2_REISSUE)가 닫혀 있는 동안은 권한 소비도 INSERT 도 0회다.
   */
  const notIssuedRetryHarness = (autoResolveMode: 'off' | 'observe' | 'on' = 'off') => {
    const command = query();
    const deliveryRefresh = query();
    const finder = query(undefined, [
      candidate({ status: 'STARTED', externalIssueCount: 1, resolution: null, deliveryClaimToken: ISO }),
    ]);
    const consumeInitialIssueAuthority = jest.fn();
    const consumeNotIssuedRetryAuthority = jest.fn().mockResolvedValue(true);
    const markSucceededAfterDeliveryClaimRelease = jest.fn().mockResolvedValue(true);
    const issue = jest.fn();
    const resolve = jest.fn().mockResolvedValue('NOT_ISSUED');
    const recordResolution = jest.fn().mockResolvedValue(true);
    const service = makeService(sweepRepo({ finder, command, deliveryRefresh }), {
      delivery: { findOne: jest.fn().mockResolvedValue({ id: 71, ssgEventId: 42 }) },
      ssgEvent: { findOne: jest.fn().mockResolvedValue({ id: 42 }) },
      pinCmd: {
        consumeInitialIssueAuthority,
        consumeNotIssuedRetryAuthority,
        recordResolution,
        markSucceededAfterDeliveryClaimRelease,
        markSucceeded: jest.fn(),
      },
      partner: { resolveDeferredSsgIssue: resolve, issue },
      autoResolveMode,
    });
    return { service, resolve, issue, consumeInitialIssueAuthority, consumeNotIssuedRetryAuthority, recordResolution };
  };

  it('P30 게이트가 닫혀 있으면 NOT_ISSUED 판정도 재발급 권한을 소비하지 않고 운영 확인으로 간다', async () => {
    const h = notIssuedRetryHarness();

    const stats = await h.service.resolvePinIssuesOnce();

    expect(h.resolve).toHaveBeenCalledTimes(1);
    expect(h.consumeInitialIssueAuthority).not.toHaveBeenCalled();
    expect(h.consumeNotIssuedRetryAuthority).not.toHaveBeenCalled();
    expect(h.issue).not.toHaveBeenCalled();
    expect(h.recordResolution).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ resolution: 'NOT_ISSUED', status: PinIssueCommandStatus.OPS_REVIEW_REQUIRED }),
    );
    expect(stats.opsReview).toBe(1);
  });

  // 배포 상수를 뒤집는 것만으로는 재발급이 열리지 않는다 — 실행 증거(§5-4) 수집은 P3 소관이다.
  // 그래도 count-1 STARTED 회수 경로가 **최초 INSERT 를 재실행하지 않는다**는 원래 불변식은 그대로다.
  it('routes a reclaimed batch count-1 STARTED command through the resolver, never re-INSERTing the initial call', async () => {
    (SSG_AUTORESOLVE_PHASE as { ORDINAL_2_REISSUE: boolean }).ORDINAL_2_REISSUE = true;
    try {
      const h = notIssuedRetryHarness('on');

      const stats = await h.service.resolvePinIssuesOnce();

      expect(h.resolve).toHaveBeenCalledTimes(1);
      expect(h.consumeInitialIssueAuthority).not.toHaveBeenCalled();
      // 증거 미수집 → fail-closed. 권한 소비도 INSERT 도 없고 운영 확인으로 간다.
      expect(h.consumeNotIssuedRetryAuthority).not.toHaveBeenCalled();
      expect(h.issue).not.toHaveBeenCalled();
      expect(stats.opsReview).toBe(1);
    } finally {
      (SSG_AUTORESOLVE_PHASE as { ORDINAL_2_REISSUE: boolean }).ORDINAL_2_REISSUE = false;
    }
  });

  it('reclaims a crashed count-0 STARTED command as STARTED so the initial INSERT can resume', async () => {
    const command = query();
    const service = makeService(sweepRepo({ command }));

    await service.claimPinCommand(candidate({ status: 'STARTED', externalIssueCount: 0 }), new Date());

    expect(command.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'STARTED' }));
    const eligibility = command.andWhere.mock.calls.find((call: any[]) => String(call[0]).includes(':started'))[0];
    expect(eligibility).toContain('status = :started AND (lease_expires_at IS NULL OR lease_expires_at < :now)');
  });

  it('reclaims a crashed count-1 STARTED command as RETRYING for resolver-only replay', async () => {
    const command = query();
    const service = makeService(sweepRepo({ command }));

    await service.claimPinCommand(candidate({ status: 'STARTED', externalIssueCount: 1 }), new Date());

    expect(command.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'RETRYING' }));
  });

  it('holds a reclaimed non-batch STARTED command for ops instead of resuming caller-specific work', async () => {
    const command = query();
    const finder = query(undefined, [
      candidate({ status: 'STARTED', externalIssueCount: 0, resolution: null, deliveryClaimToken: null }),
    ]);
    const recordResolution = jest.fn().mockResolvedValue(true);
    const issue = jest.fn();
    const resolve = jest.fn();
    const service = makeService(sweepRepo({ finder, command }), {
      delivery: { findOne: jest.fn().mockResolvedValue({ id: 71, ssgEventId: null }) },
      pinCmd: {
        consumeInitialIssueAuthority: jest.fn(),
        consumeNotIssuedRetryAuthority: jest.fn(),
        recordResolution,
        markSucceededAfterDeliveryClaimRelease: jest.fn(),
      },
      partner: { resolveDeferredSsgIssue: resolve, issue },
    });

    const stats = await service.resolvePinIssuesOnce();

    expect(recordResolution).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ resolution: 'UNKNOWN', status: 'OPS_REVIEW_REQUIRED' }),
    );
    expect(issue).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(stats.opsReview).toBe(1);
  });

  // HIGH 2: lease_expires_at 컬럼 신설 전 backfill 안 된 STARTED(lease=NULL)도 회수 대상이어야 한다.
  it('selects lease-null STARTED rows so legacy migration residue cannot stall the fence', async () => {
    const finder = query(undefined, []);
    const service = makeService(sweepRepo({ finder, command: query() }));

    await service.findDuePinCommands(new Date());

    const where = finder.where.mock.calls.map((call: any[]) => String(call[0])).join(' ');
    expect(where).toContain('c.status = :started');
    expect(where).toContain('c.lease_expires_at IS NULL OR c.lease_expires_at < :now');
  });

  it('claims lease-null STARTED rows (CAS predicate tolerates a missing lease)', async () => {
    const command = query();
    const service = makeService(sweepRepo({ command }));

    await service.claimPinCommand(
      candidate({ status: 'STARTED', externalIssueCount: 1, leaseExpiresAt: null }),
      new Date(),
    );

    const eligibility = command.andWhere.mock.calls.find((call: any[]) => String(call[0]).includes(':started'))[0];
    expect(eligibility).toContain('status = :started AND (lease_expires_at IS NULL OR lease_expires_at < :now)');
  });
});
