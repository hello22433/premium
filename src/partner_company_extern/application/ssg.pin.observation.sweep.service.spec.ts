import { PinIssueCommandStatus } from '../../delivery/interface/pin.issue.command.status';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { SsgPinResolution } from '../interface/ssg.issue';
import { SsgAutoResolveConfig } from './ssg.autoresolve.config';
import { SsgPinObservationSweepService } from './ssg.pin.observation.sweep.service';

/**
 * EP-P30 §9-3 — observe 는 **관측만** 하고, 관측 모집단은 backlog 전체를 대표해야 한다.
 *
 * 이 파일이 잠그는 불변식 셋:
 *  1. 관측 경로에서 command·delivery 가 단 한 번도 mutate 되지 않는다
 *  2. 어떤 command 도 관측에서 영구히 굶지 않는다(가장 오래 관측 안 된 순)
 *  3. 정상 진행 중(in-flight) 발급이 "미시도(NOT_ATTEMPTED)" 표본으로 오염되지 않는다
 */
describe('SsgPinObservationSweepService', () => {
  const HOUR_AGO = new Date(Date.now() - 60 * 60_000);

  const command = (overrides: Partial<any> = {}) => ({
    id: '11',
    orderDeliveryId: 9001,
    status: PinIssueCommandStatus.OPS_REVIEW_REQUIRED,
    externalIssueCount: 1,
    stateEnteredAt: HOUR_AGO,
    leaseExpiresAt: null,
    autoresolveVersion: null,
    ...overrides,
  });

  /**
   * 적격성 조건이 SQL 에 있는지를 실제로 검증하려면 모사 빌더가 where 절을 해석해야 한다.
   * 앞 50건이 in-flight 이고 51번째만 적격인 상황을 재현하는 게 이 회귀의 핵심이다.
   */
  const fakeQueryBuilder = (rows: any[], limit = SsgPinObservationSweepService.OBSERVE_LIMIT) => {
    const predicates: Array<(row: any) => boolean> = [];
    const clauses: Array<[string, any]> = [];

    const applyClause = (sql: string, params: any = {}) => {
      clauses.push([sql, params]);
      if (sql.includes('c.partner_type')) predicates.push((r) => (r.partnerType ?? 'SSG') === params.partnerType);
      else if (sql.includes('c.status IN')) predicates.push((r) => (params.statuses as string[]).includes(r.status));
      else if (sql.includes('NOT (c.status'))
        predicates.push((r) => !(r.status === params.started && r.externalIssueCount === 0));
      else if (sql.includes('c.lease_expires_at'))
        predicates.push((r) => !r.leaseExpiresAt || r.leaseExpiresAt.getTime() <= params.now.getTime());
      else if (sql.includes('c.state_entered_at'))
        predicates.push((r) => !r.stateEnteredAt || r.stateEnteredAt.getTime() <= params.dwellCutoff.getTime());
      else if (sql.includes('c.autoresolve_version')) predicates.push((r) => r.autoresolveVersion === 1);
    };

    const queryBuilder: any = {
      clauses,
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn((sql: string, params: any) => (applyClause(sql, params), queryBuilder)),
      andWhere: jest.fn((sql: string, params: any) => (applyClause(sql, params), queryBuilder)),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn(async () => rows.filter((row) => predicates.every((p) => p(row))).slice(0, limit)),
    };
    return queryBuilder;
  };

  const build = (mode: string, commands: any[], limit?: number) => {
    const queryBuilder = fakeQueryBuilder(commands, limit);
    const repository = { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) };
    const extern = {
      classifyDeferredSsgIssue: jest.fn().mockResolvedValue({
        resolution: SsgPinResolution.NOT_ISSUED,
        hasAnyAttempt: true,
        activeCandidateCount: 1,
        verdicts: [{ candidate: { id: 7 }, resolution: SsgPinResolution.NOT_ISSUED, tryYn: 'N', resultCd: null }],
      }),
      // 관측이 절대 부르면 안 되는 부작용 API
      applyConfirmedCandidate: jest.fn(),
      resolveDeferredSsgIssue: jest.fn(),
    };
    const observation = { record: jest.fn().mockResolvedValue(true) };
    const config = new SsgAutoResolveConfig({ get: () => mode } as any);
    const sut = new SsgPinObservationSweepService(repository as any, extern as any, observation as any, config);
    return { sut, queryBuilder, extern, observation };
  };

  describe('부작용 없음', () => {
    it('mode=off + 미enrollment command → 판정도 관측도 하지 않는다', async () => {
      const { sut, extern, observation } = build('off', [command()]);

      await expect(sut.observeOnce()).resolves.toMatchObject({ candidates: 0, recorded: 0 });
      expect(extern.classifyDeferredSsgIssue).not.toHaveBeenCalled();
      expect(observation.record).not.toHaveBeenCalled();
    });

    it('mode=observe → 순수 판정만 부르고 command·delivery 를 건드리지 않는다', async () => {
      const { sut, extern, observation } = build('observe', [command()]);

      await expect(sut.observeOnce()).resolves.toMatchObject({ candidates: 1, recorded: 1, failed: 0 });

      expect(extern.classifyDeferredSsgIssue).toHaveBeenCalledWith(9001);
      expect(extern.applyConfirmedCandidate).not.toHaveBeenCalled();
      expect(extern.resolveDeferredSsgIssue).not.toHaveBeenCalled();
      expect(observation.record).toHaveBeenCalledWith(
        expect.objectContaining({
          pinIssueCommandId: '11',
          orderDeliveryId: 9001,
          mode: 'observe',
          aggregateResolution: SsgPinResolution.NOT_ISSUED,
          candidates: [expect.objectContaining({ ssgIssueLogId: 7, tryYn: 'N' })],
        }),
      );
    });

    it('mode=off 라도 enrollment 된 command 는 drain 관측 대상이다', async () => {
      const { sut, observation } = build('off', [command({ autoresolveVersion: 1 })]);

      await sut.observeOnce();

      expect(observation.record).toHaveBeenCalledTimes(1);
    });
  });

  describe('모집단 공정성', () => {
    it('가장 오래 관측 안 된 순으로 뽑는다 — id ASC 고정이면 51번째부터 영구 기아', async () => {
      const { sut, queryBuilder } = build('observe', []);

      await sut.observeOnce();

      expect(queryBuilder.leftJoin).toHaveBeenCalledWith(
        'ssg_pin_observation_run',
        'r',
        expect.stringContaining('r.pin_issue_command_id = c.id'),
      );
      // 미관측(NULL) 우선 → 오래된 관측 순 → 동률은 id
      expect(queryBuilder.orderBy).toHaveBeenCalledWith('MAX(r.completed_at) IS NOT NULL', 'ASC');
      expect(queryBuilder.addOrderBy).toHaveBeenNthCalledWith(1, 'MAX(r.completed_at)', 'ASC');
      expect(queryBuilder.addOrderBy).toHaveBeenNthCalledWith(2, 'c.id', 'ASC');
    });

    it('SSG 미확정 command 만, OPS_REVIEW_REQUIRED 동결분 포함해서 본다', async () => {
      const { sut, queryBuilder } = build('observe', []);

      await sut.observeOnce();

      expect(queryBuilder.where).toHaveBeenCalledWith('c.partner_type = :partnerType', {
        partnerType: IPartnerCompanyType.SSG,
      });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('c.status IN (:...statuses)', {
        statuses: SsgPinObservationSweepService.OBSERVED_STATUSES,
      });
      expect(SsgPinObservationSweepService.OBSERVED_STATUSES).toContain(PinIssueCommandStatus.OPS_REVIEW_REQUIRED);
      // 선점하지 않으므로 next_attempt due 조건은 붙지 않는다 (lease 는 in-flight 제외용).
      const sqlClauses: string[] = queryBuilder.clauses.map(([sql]: [string]) => sql);
      expect(sqlClauses.some((sql) => sql.includes('next_attempt_at'))).toBe(false);
    });

    it('앞 50건이 in-flight 이면 51번째 적격 command 가 **같은 주기에** 관측된다', async () => {
      const inFlight = Array.from({ length: 50 }, (_, i) =>
        command({
          id: String(100 + i),
          orderDeliveryId: 100 + i,
          status: PinIssueCommandStatus.STARTED,
          externalIssueCount: 0,
        }),
      );
      const eligible = command({ id: '999', orderDeliveryId: 999 });
      const { sut, observation } = build('observe', [...inFlight, eligible]);

      await expect(sut.observeOnce()).resolves.toMatchObject({ candidates: 1, recorded: 1 });
      expect(observation.record).toHaveBeenCalledWith(expect.objectContaining({ pinIssueCommandId: '999' }));
    });

    it('off + 앞 50건이 미enrollment 이면 뒤의 drain command 가 관측된다', async () => {
      const notEnrolled = Array.from({ length: 50 }, (_, i) =>
        command({ id: String(200 + i), orderDeliveryId: 200 + i, autoresolveVersion: null }),
      );
      const drain = command({ id: '777', orderDeliveryId: 777, autoresolveVersion: 1 });
      const { sut, observation } = build('off', [...notEnrolled, drain]);

      await expect(sut.observeOnce()).resolves.toMatchObject({ candidates: 1, recorded: 1 });
      expect(observation.record).toHaveBeenCalledWith(expect.objectContaining({ pinIssueCommandId: '777' }));
    });

    it('off + 미enrollment 만 있으면 관측 대상 자체가 없다', async () => {
      const { sut, observation } = build('off', [command({ autoresolveVersion: null })]);

      await expect(sut.observeOnce()).resolves.toMatchObject({ candidates: 0, recorded: 0 });
      expect(observation.record).not.toHaveBeenCalled();
    });
  });

  describe('in-flight 오염 차단', () => {
    it('STARTED + count=0 은 아직 INSERT 전이라 미시도 표본이 아니다 — 관측 제외', async () => {
      const { sut, extern, observation } = build('observe', [
        command({ status: PinIssueCommandStatus.STARTED, externalIssueCount: 0 }),
      ]);

      await expect(sut.observeOnce()).resolves.toMatchObject({ candidates: 0, recorded: 0 });
      expect(extern.classifyDeferredSsgIssue).not.toHaveBeenCalled();
      expect(observation.record).not.toHaveBeenCalled();
    });

    it('live lease 를 쥔 command 는 다른 worker 가 실행 중이므로 제외', async () => {
      const { sut, observation } = build('observe', [command({ leaseExpiresAt: new Date(Date.now() + 60_000) })]);

      await expect(sut.observeOnce()).resolves.toMatchObject({ candidates: 0, recorded: 0 });
      expect(observation.record).not.toHaveBeenCalled();
    });

    it('체류 5분 미만은 로그 반영 지연일 수 있어 제외', async () => {
      const { sut, observation } = build('observe', [command({ stateEnteredAt: new Date(Date.now() - 60_000) })]);

      await expect(sut.observeOnce()).resolves.toMatchObject({ candidates: 0, recorded: 0 });
      expect(observation.record).not.toHaveBeenCalled();
    });

    it('관측 당시 command 스냅샷을 함께 남긴다 (사후 in-flight 필터링 근거)', async () => {
      const lease = new Date(Date.now() - 1000);
      const { sut, observation } = build('observe', [
        command({ status: PinIssueCommandStatus.RETRY_PENDING, externalIssueCount: 1, leaseExpiresAt: lease }),
      ]);

      await sut.observeOnce();

      expect(observation.record).toHaveBeenCalledWith(
        expect.objectContaining({
          commandSnapshot: {
            status: PinIssueCommandStatus.RETRY_PENDING,
            externalIssueCount: 1,
            stateEnteredAt: HOUR_AGO,
            leaseExpiresAt: lease,
          },
        }),
      );
    });
  });

  describe('판정값 보존', () => {
    it('후보 0건(NOT_ATTEMPTED)도 candidateCount=0 run 으로 기록한다', async () => {
      const { sut, extern, observation } = build('observe', [command()]);
      extern.classifyDeferredSsgIssue.mockResolvedValue({
        resolution: SsgPinResolution.NOT_ATTEMPTED,
        hasAnyAttempt: false,
        activeCandidateCount: 0,
        verdicts: [],
      });

      await sut.observeOnce();

      expect(observation.record).toHaveBeenCalledWith(
        expect.objectContaining({ aggregateResolution: SsgPinResolution.NOT_ATTEMPTED, candidates: [] }),
      );
    });

    it('tombstone-only UNKNOWN 도 기록에서 빠지지 않는다', async () => {
      const { sut, extern, observation } = build('observe', [command()]);
      extern.classifyDeferredSsgIssue.mockResolvedValue({
        resolution: SsgPinResolution.UNKNOWN,
        hasAnyAttempt: true,
        activeCandidateCount: 0,
        verdicts: [],
      });

      await sut.observeOnce();

      expect(observation.record).toHaveBeenCalledWith(
        expect.objectContaining({ aggregateResolution: SsgPinResolution.UNKNOWN, candidates: [] }),
      );
    });
  });

  describe('내성', () => {
    it('한 건의 판정 실패가 나머지 표본을 날리지 않는다', async () => {
      const { sut, extern, observation } = build('observe', [command({ id: '11' }), command({ id: '12' })]);
      extern.classifyDeferredSsgIssue.mockRejectedValueOnce(new Error('SSG 조회 실패'));

      await expect(sut.observeOnce()).resolves.toMatchObject({ candidates: 2, recorded: 1, failed: 1 });
      expect(observation.record).toHaveBeenCalledTimes(1);
    });

    it('버킷 중복(경합 패자)은 recorded 로 세지 않는다', async () => {
      const { sut, observation } = build('observe', [command()]);
      observation.record.mockResolvedValue(false);

      await expect(sut.observeOnce()).resolves.toMatchObject({ candidates: 1, recorded: 0, failed: 0 });
    });
  });
});
