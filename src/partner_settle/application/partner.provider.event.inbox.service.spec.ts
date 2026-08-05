import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { buildFingerprint } from '../domain/provider.event.fingerprint';
import { parseKstDateTime } from '../domain/settle.time';
import {
  ObservationLaneInput,
  OrphanIngressInput,
  PartnerProviderEventInboxService,
} from './partner.provider.event.inbox.service';

const OBSERVED_AT = parseKstDateTime('2026-07-31 09:00:00.123456');

/**
 * inbox 테이블을 흉내내는 in-memory 저장소.
 * `origin`·`processedStatus` 조합과 orphan ingress UNIQUE 는 DB 가 강제하는 규칙이라 여기서도 지킨다.
 */
function mockInboxRepository() {
  const rows: Record<string, unknown>[] = [];

  return {
    rows,
    query: jest.fn(async (sql: string, parameters: unknown[]) => {
      if (!sql.startsWith('INSERT INTO partner_provider_event_inbox')) return [];

      const columns = [...sql.matchAll(/`([a-z_]+)`/g)].map((matched) => matched[1]);
      const row: Record<string, unknown> = { id: rows.length + 1 };
      columns.forEach((column, index) => {
        row[column.replace(/_([a-z])/g, (_all, letter: string) => letter.toUpperCase())] = parameters[index];
      });

      const ingress = row.ingressFingerprint;
      if (
        ingress !== null &&
        rows.some(
          (existing) =>
            existing.provider === row.provider &&
            existing.orderDeliveryId === row.orderDeliveryId &&
            existing.ingressFingerprint === ingress,
        )
      ) {
        // 제약 이름이 있어야 서비스가 "동시 ingress 수렴"으로 판정한다(MySQL 8 형상).
        throw Object.assign(new Error('ER_DUP_ENTRY'), {
          errno: 1062,
          sqlMessage: `Duplicate entry 'x' for key 'partner_provider_event_inbox.uk_partner_provider_event_inbox_ingress'`,
        });
      }

      rows.push(row);
      return { insertId: row.id };
    }),
    findOne: jest.fn(async ({ where, order }: { where: Record<string, unknown>; order?: unknown }) => {
      const matched = rows.filter((row) => {
        if (row.provider !== where.provider || row.orderDeliveryId !== where.orderDeliveryId) return false;
        if (where.ingressFingerprint !== undefined) return row.ingressFingerprint === where.ingressFingerprint;
        // `In(['POLL','PUSH','MANUAL'])` — orphan lane 은 관측 lane 조회에 잡히면 안 된다.
        return ['POLL', 'PUSH', 'MANUAL'].includes(row.origin as string);
      });
      if (!order) return matched[0] ?? null;
      return matched.sort((a, b) => (b.id as number) - (a.id as number))[0] ?? null;
    }),
    update: jest.fn(async (criteria: Record<string, unknown>, patch: Record<string, unknown>) => {
      const target = rows.find(
        (row) =>
          row.id === criteria.id &&
          (criteria.processedStatus === undefined || row.processedStatus === criteria.processedStatus),
      );
      if (!target) return { affected: 0 };
      Object.assign(target, patch);
      return { affected: 1 };
    }),
  };
}

function build() {
  const inboxRepository = mockInboxRepository();
  let observationId = 0;
  const observationService = {
    recordUnresolved: jest.fn(async (input: { evidenceKey: string }) => ({
      id: (observationId += 1),
      evidenceKey: input.evidenceKey,
    })),
  };
  const service = new PartnerProviderEventInboxService(inboxRepository as never, observationService as never);

  return { service, inboxRepository, observationService };
}

function observationInput(overrides: Partial<ObservationLaneInput> = {}): ObservationLaneInput {
  const observedStatus = overrides.observedStatus ?? 'USED';
  return {
    provider: IPartnerCompanyType.DAOU,
    orderDeliveryId: 100,
    sourceType: 'EXCHANGE',
    origin: 'POLL',
    normalizedPayload: { barcode: 'B1', cpnStatus: observedStatus },
    payloadFingerprint: buildFingerprint(['B1', observedStatus, '20260731']),
    observedStatus,
    observedAt: OBSERVED_AT,
    prevStatus: 'ISSUED',
    ...overrides,
  };
}

function orphanInput(overrides: Partial<OrphanIngressInput> = {}): OrphanIngressInput {
  return {
    provider: IPartnerCompanyType.GALAXIA,
    orderDeliveryId: 100,
    sourceType: 'USAGE',
    normalizedPayload: { barcode: 'B1', appDiv: '10', amount: 5000 },
    payloadFingerprint: buildFingerprint(['B1', '10', 5000, null]),
    ingressFingerprint: buildFingerprint(['B1', 'cpn', '10', null, 5000]),
    observedStatus: 'USED',
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

describe('PartnerProviderEventInboxService.observe (관측 lane)', () => {
  it('신규 관측은 PENDING 으로 append 한 뒤 observation 연결로 LINKED 가 된다', async () => {
    const { service, inboxRepository, observationService } = build();

    const result = await service.observe(observationInput());

    expect(result.appended).toBe(true);
    expect(inboxRepository.rows).toHaveLength(1);
    expect(result.inboxRow.processedStatus).toBe('LINKED');
    expect(result.inboxRow.observationId).toBe(1);
    // evidence 는 payload fingerprint 가 아니라 inbox row id 다(48차-B1).
    expect(observationService.recordUnresolved.mock.calls[0][0].evidenceKey).toBe('INBOX:1');
  });

  it('관측 시각을 마이크로초까지 저장한다', async () => {
    const { service, inboxRepository } = build();

    await service.observe(observationInput());

    expect(inboxRepository.rows[0].observedAt).toBe('2026-07-31 09:00:00.123456');
  });

  it('동일 상태·fingerprint 재조회는 신규 row 를 만들지 않는다', async () => {
    const { service, inboxRepository, observationService } = build();

    await service.observe(observationInput());
    const second = await service.observe(observationInput());

    // 재스캔마다 row 가 늘면 evidence 가 의미를 잃고 관측 수가 폭증한다.
    expect(second.appended).toBe(false);
    expect(inboxRepository.rows).toHaveLength(1);
    expect(observationService.recordUnresolved).toHaveBeenCalledTimes(1);
  });

  it('USED → CANCEL → USED 는 매번 신규 row 를 append 한다', async () => {
    const { service, inboxRepository } = build();

    await service.observe(observationInput({ observedStatus: 'USED' }));
    await service.observe(observationInput({ observedStatus: 'CANCEL' }));
    await service.observe(observationInput({ observedStatus: 'USED' }));

    // 같은 상태로 돌아왔다고 두 번째 USED 를 삼키면 재사용 사건이 통째로 사라진다.
    expect(inboxRepository.rows).toHaveLength(3);
    expect(inboxRepository.rows.map((row) => row.prevInboxRowId)).toEqual([null, 1, 2]);
  });

  it('append 후 crash 로 남은 PENDING 은 payload 비교 전에 복구된다', async () => {
    const { service, inboxRepository, observationService } = build();
    await service.observe(observationInput({ observedStatus: 'USED' }));
    // observation 생성 직전 크래시 재현 — row 는 PENDING 으로 남는다.
    inboxRepository.rows[0].processedStatus = 'PENDING';
    inboxRepository.rows[0].observationId = null;
    observationService.recordUnresolved.mockClear();

    const result = await service.observe(observationInput({ observedStatus: 'USED' }));

    // 복구를 payload 비교 뒤로 미루면 같은 payload 일 때 PENDING 이 영원히 남는다.
    expect(inboxRepository.rows[0].processedStatus).toBe('LINKED');
    expect(result.appended).toBe(false);
    expect(observationService.recordUnresolved).toHaveBeenCalledTimes(1);
  });

  it('PENDING 복구가 그 사이 들어온 새 payload 를 유실하지 않는다', async () => {
    const { service, inboxRepository } = build();
    await service.observe(observationInput({ observedStatus: 'USED' }));
    inboxRepository.rows[0].processedStatus = 'PENDING';
    inboxRepository.rows[0].observationId = null;

    const result = await service.observe(observationInput({ observedStatus: 'CANCEL' }));

    expect(inboxRepository.rows).toHaveLength(2);
    expect(inboxRepository.rows[0].processedStatus).toBe('LINKED');
    expect(result.inboxRow.observedStatus).toBe('CANCEL');
  });

  it('orphan lane row 는 관측 lane 최신 row 판정에 섞이지 않는다', async () => {
    const { service, inboxRepository } = build();
    await service.ingressOrphan(orphanInput({ provider: IPartnerCompanyType.DAOU }));

    const result = await service.observe(observationInput());

    // orphan 승인 대기 row 가 최신으로 잡히면 이후 poll 이 그 row 를 LINKED 처리해 lane 이 무너진다.
    expect(result.appended).toBe(true);
    expect(result.inboxRow.origin).toBe('POLL');
    expect(inboxRepository.rows[0].processedStatus).toBe('ORPHAN_PENDING');
  });
});

describe('PartnerProviderEventInboxService.ingressOrphan (orphan lane)', () => {
  it('동일 malformed 재수신은 1 row 로 수렴한다', async () => {
    const { service, inboxRepository } = build();

    const first = await service.ingressOrphan(orphanInput());
    const second = await service.ingressOrphan(orphanInput());

    expect(first.appended).toBe(true);
    expect(second.appended).toBe(false);
    expect(second.inboxRow.id).toBe(first.inboxRow.id);
    expect(inboxRepository.rows).toHaveLength(1);
  });

  it('orphan 은 observation 을 만들지 않는다', async () => {
    const { service, observationService } = build();

    const result = await service.ingressOrphan(orphanInput());

    // orphan 은 전이 시퀀스가 아니라 시각만 없는 확정 사건이다.
    expect(observationService.recordUnresolved).not.toHaveBeenCalled();
    expect(result.inboxRow.observationId).toBeNull();
    expect(result.inboxRow.processedStatus).toBe('ORPHAN_PENDING');
    expect(result.inboxRow.ingressFingerprint).toBe(orphanInput().ingressFingerprint);
  });

  it('비시각 필드가 다르면 별개 사건으로 적재한다', async () => {
    const { service, inboxRepository } = build();

    await service.ingressOrphan(orphanInput());
    await service.ingressOrphan(orphanInput({ ingressFingerprint: buildFingerprint(['B1', 'cpn', '20', null, 5000]) }));

    expect(inboxRepository.rows).toHaveLength(2);
  });
});

describe('PartnerProviderEventInboxService.claimOrphanForAutoLedger', () => {
  it('ORPHAN_PENDING 을 자동 정산으로 1회만 선점한다', async () => {
    const { service, inboxRepository } = build();
    const { inboxRow } = await service.ingressOrphan(orphanInput());

    const first = await service.claimOrphanForAutoLedger(inboxRow.id);
    const second = await service.claimOrphanForAutoLedger(inboxRow.id);

    // 두 번 성공하면 자동 정산과 수동 승인이 같은 사건을 이중 원장화한다.
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(inboxRepository.rows[0].processedStatus).toBe('ORPHAN_AUTO_LEDGERED');
    expect(inboxRepository.rows[0].manualLedgerProposalId).toBeNull();
  });

  it('이미 수동 승인된 orphan 은 자동 claim 하지 못한다', async () => {
    const { service, inboxRepository } = build();
    const { inboxRow } = await service.ingressOrphan(orphanInput());
    inboxRepository.rows[0].processedStatus = 'ORPHAN_LEDGERED';

    await expect(service.claimOrphanForAutoLedger(inboxRow.id)).resolves.toBe(false);
  });
});
