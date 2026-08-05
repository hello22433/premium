import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { parseKstDateTime } from '../domain/settle.time';
import { PartnerSettleObservationService } from './partner.settle.observation.service';

const OBSERVED_AT = parseKstDateTime('2026-07-31 09:00:00.000000');
const SOURCE_OCCURRED_AT = parseKstDateTime('2026-07-30 18:20:31.123456');

function mockObservationRepository() {
  const rows: Record<string, unknown>[] = [];

  return {
    rows,
    query: jest.fn(async (sql: string, parameters: unknown[]) => {
      if (!sql.startsWith('INSERT INTO partner_settle_transition_observation')) return [];

      const columns = [...sql.matchAll(/`([a-z_]+)`/g)].map((matched) => matched[1]);
      const row: Record<string, unknown> = { id: rows.length + 1 };
      columns.forEach((column, index) => {
        row[column.replace(/_([a-z])/g, (_all, letter: string) => letter.toUpperCase())] = parameters[index];
      });

      if (rows.some((existing) => existing.observationKey === row.observationKey)) {
        // 제약 이름이 있어야 서비스가 "재관측 수렴"으로 판정한다(MySQL 8 형상).
        throw Object.assign(new Error('ER_DUP_ENTRY'), {
          errno: 1062,
          sqlMessage: `Duplicate entry 'x' for key 'partner_settle_transition_observation.uk_partner_settle_observation_key'`,
        });
      }
      rows.push(row);
      return { insertId: row.id };
    }),
    findOne: jest.fn(
      async ({ where }: { where: { observationKey: string } }) =>
        rows.find((row) => row.observationKey === where.observationKey) ?? null,
    ),
    count: jest.fn(
      async ({ where }: { where: { unresolvedBaseKey: string } }) =>
        rows.filter((row) => row.unresolvedBaseKey === where.unresolvedBaseKey).length,
    ),
    update: jest.fn(async (criteria: { id: number }, patch: Record<string, unknown>) => {
      const target = rows.find((row) => row.id === criteria.id);
      if (!target) return { affected: 0 };
      Object.assign(target, patch);
      return { affected: 1 };
    }),
  };
}

function build() {
  const repository = mockObservationRepository();
  return { repository, service: new PartnerSettleObservationService(repository as never) };
}

const FACTS = {
  provider: IPartnerCompanyType.GIFT_SHOW,
  orderDeliveryId: 100,
  sourceType: 'EXCHANGE' as const,
  prevStatus: 'ISSUED',
  newStatus: 'USED',
  observedAt: OBSERVED_AT,
};

describe('PartnerSettleObservationService.recordResolved', () => {
  it('provider 증적 ID 로 RESOLVED 관측을 만든다', async () => {
    const { service, repository } = build();

    const observation = await service.recordResolved({
      ...FACTS,
      sourceEventId: 'T1|20|20260730182031',
      sourceOccurredAt: SOURCE_OCCURRED_AT,
    });

    expect(observation.observationKey).toBe('EXC:GIFT_SHOW:EXCHANGE:T1|20|20260730182031');
    expect(repository.rows[0].resolutionStatus).toBe('RESOLVED');
    expect(repository.rows[0].sourceEventIdOrigin).toBe('PROVIDER');
    // 정상 관측에 미복원 필드가 섞이면 DB CHECK 조합이 깨진다.
    expect(repository.rows[0].unresolvedBaseKey).toBeNull();
    expect(repository.rows[0].generation).toBeNull();
    expect(repository.rows[0].sourceOccurredAt).toBe('2026-07-30 18:20:31.123456');
  });

  it('같은 사건 재관측은 신규 row 를 만들지 않는다', async () => {
    const { service, repository } = build();

    const first = await service.recordResolved({ ...FACTS, sourceEventId: 'T1' });
    const second = await service.recordResolved({ ...FACTS, sourceEventId: 'T1' });

    expect(repository.rows).toHaveLength(1);
    expect(second.id).toBe(first.id);
  });
});

describe('PartnerSettleObservationService.recordUnresolved', () => {
  it('미복원 관측은 base+evidence 를 영구 identity 로 쓴다', async () => {
    const { service, repository } = build();

    const observation = await service.recordUnresolved({ ...FACTS, evidenceKey: 'INBOX:7', runId: 'run-1' });

    expect(observation.observationKey).toBe('UNRES:GIFT_SHOW:100:EXCHANGE:INBOX:7');
    expect(repository.rows[0].resolutionStatus).toBe('UNRESOLVED');
    expect(repository.rows[0].sourceEventId).toBeNull();
    expect(repository.rows[0].sourceEventIdOrigin).toBeNull();
    expect(repository.rows[0].generation).toBe(1);
  });

  it('같은 evidence 재실행은 lastSeenRunId 만 갱신한다', async () => {
    const { service, repository } = build();

    await service.recordUnresolved({ ...FACTS, evidenceKey: 'INBOX:7', runId: 'run-1' });
    const second = await service.recordUnresolved({ ...FACTS, evidenceKey: 'INBOX:7', runId: 'run-2' });

    expect(repository.rows).toHaveLength(1);
    expect(second.firstSeenRunId).toBe('run-1');
    expect(second.lastSeenRunId).toBe('run-2');
  });

  it('서로 다른 evidence 의 UNRESOLVED 는 공존한다', async () => {
    const { service, repository } = build();

    await service.recordUnresolved({ ...FACTS, evidenceKey: 'INBOX:7' });
    await service.recordUnresolved({ ...FACTS, evidenceKey: 'INBOX:9' });

    // 활성 UNRESOLVED 1건 제한을 두면 E1 미해소 중 도착한 실제 새 전이 E2 가 삼켜진다(15차).
    expect(repository.rows).toHaveLength(2);
    expect(repository.rows.map((row) => row.generation)).toEqual([1, 2]);
  });
});
