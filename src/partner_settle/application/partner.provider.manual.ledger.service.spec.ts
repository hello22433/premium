import { BadRequestException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { PartnerProviderManualLedgerService } from './partner.provider.manual.ledger.service';
import { PartnerProviderManualLedgerProposalEntity } from '../../entity/partner.provider.manual.ledger.proposal.entity';
import { PartnerProviderEventInboxEntity } from '../../entity/partner.provider.event.inbox.entity';
import { PartnerSettleLedgerEntity } from '../../entity/partner.settle.ledger.entity';

describe('PartnerProviderManualLedgerService', () => {
  const command = {
    provider: 'GALAXIA',
    inboxRowId: 1,
    resolutionMode: 'DISCARD' as const,
    proposedLedgerFacts: null,
    evidenceRef: 'ticket://1',
    reason: 'not settlement',
    requestKey: 'request_1',
  };
  it('rejects client-derived scope and invalid request keys', async () => {
    const service = new PartnerProviderManualLedgerService({ findOne: jest.fn() } as never, {} as never, {} as never);
    await expect(service.propose({ ...command, sourceType: 'USAGE' }, 1)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.propose({ ...command, requestKey: 'bad key' }, 1)).rejects.toBeInstanceOf(BadRequestException);
  });
  it('replays same request and rejects a different assertion payload', async () => {
    const service: any = new PartnerProviderManualLedgerService(
      { findOne: jest.fn() } as never,
      {} as never,
      {} as never,
    );
    const normalized = service.normalize(command);
    const existing = {
      payloadHashVersion: 'v1',
      payloadHash: service.hash(normalized, { provider: 'GALAXIA', id: 1 }),
      id: 3,
    };
    expect(service.replay(existing, normalized)).toEqual({ proposal: existing, ledgerIds: [] });
    expect(() => service.replay(existing, { ...normalized, reason: 'different' })).toThrow(ConflictException);
  });
  it('requires facts for LEDGER and forbids them for DISCARD', () => {
    const service: any = new PartnerProviderManualLedgerService({} as never, {} as never, {} as never);
    expect(() => service.normalize({ ...command, resolutionMode: 'LEDGER' })).toThrow(BadRequestException);
    expect(() => service.normalize({ ...command, proposedLedgerFacts: { baseAmount: '1' } })).toThrow(
      BadRequestException,
    );
  });
  it('allows an omitted approval reason but requires a rejection reason', async () => {
    const dataSource = { transaction: jest.fn().mockResolvedValue('approved') };
    const service = new PartnerProviderManualLedgerService({} as never, dataSource as never, {} as never);

    await expect(service.approve(1, 2)).resolves.toBe('approved');
    await expect(service.reject(1, 2, '')).rejects.toBeInstanceOf(BadRequestException);
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
  });
  it('replays an approved proposal from its terminal inbox and linked ledgers', async () => {
    const proposal = {
      id: 1,
      orderDeliveryId: 11,
      inboxRowId: 9,
      provider: 'GALAXIA',
      sourceType: 'USAGE',
      status: 'APPROVED',
      resolutionMode: 'LEDGER',
    };
    const proposalQuery = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(proposal),
    };
    const inboxQuery = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({
        id: 9,
        provider: 'GALAXIA',
        origin: 'ORPHAN',
        processedStatus: 'ORPHAN_LEDGERED',
        manualLedgerProposalId: 1,
      }),
    };
    const repositories = new Map<unknown, unknown>([
      [
        PartnerProviderManualLedgerProposalEntity,
        {
          findOne: jest.fn().mockResolvedValue(proposal),
          createQueryBuilder: jest.fn().mockReturnValue(proposalQuery),
        },
      ],
      [
        PartnerProviderEventInboxEntity,
        {
          createQueryBuilder: jest.fn().mockReturnValue(inboxQuery),
        },
      ],
      [
        PartnerSettleLedgerEntity,
        {
          find: jest.fn().mockResolvedValue([{ id: 77 }]),
        },
      ],
    ]);
    const manager = {
      query: jest.fn().mockResolvedValue([{ id: 11 }]),
      getRepository: jest.fn((entity) => repositories.get(entity)),
    };
    const dataSource = { transaction: jest.fn((run) => run(manager)) };
    const service = new PartnerProviderManualLedgerService({} as never, dataSource as never, {} as never);

    await expect(service.approve(1, 99)).resolves.toEqual({ proposal, ledgerIds: [77] });
  });
  it('appends a positive proposal through the shared ledger with its transaction manager', async () => {
    const ledger = { appendLedger: jest.fn().mockResolvedValue({ id: 41 }) };
    const service: any = new PartnerProviderManualLedgerService({} as never, {} as never, ledger as never);
    service.settlementContext = jest.fn().mockResolvedValue({
      partnerCompanyId: 7,
      settleMethod: 'PER_PRODUCT',
      snapshot: { price: 1000, category: null, classificationId: null, brandNameKorean: null },
      subItem: { giftKind: null, brandCode: null, snapshotProductExpireDay: null },
    });
    const manager = {} as never;
    const result = await service.appendLedgers(
      {
        id: 3,
        provider: 'GALAXIA',
        sourceType: 'USAGE',
        proposedLedgerFacts: { baseAmount: '1000', occurredAt: '2026-08-06 10:00:00.123456', giftKind: 'cpn' },
        evidenceRef: 'ticket://3',
        evidenceHash: 'hash',
        reason: 'manual',
      },
      {
        id: 9,
        orderDeliveryId: 11,
        sourceType: 'USAGE',
        normalizedPayload: { amount: 1000, appDiv: '10', giftKind: 'cpn' },
      } as never,
      manager,
    );

    expect(result).toEqual([41]);
    expect(ledger.appendLedger).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'MANUAL_LEDGER:3',
        partnerCompanyId: 7,
        sourceType: 'USAGE',
        baseAmount: 1000n,
        manualLedgerProposalId: 3,
      }),
      manager,
    );
  });

  it('allocates a negative proposal across newest eligible originals deterministically', async () => {
    const ledger = { appendReversal: jest.fn().mockResolvedValueOnce({ id: 22 }).mockResolvedValueOnce({ id: 21 }) };
    const rows = [
      {
        id: 2,
        partnerCompanyId: 7,
        orderDeliveryId: 11,
        sourceType: 'USAGE',
        reversesLedgerId: null,
        status: 'NORMAL',
        baseAmount: '40',
      },
      {
        id: 1,
        partnerCompanyId: 7,
        orderDeliveryId: 11,
        sourceType: 'USAGE',
        reversesLedgerId: null,
        status: 'NORMAL',
        baseAmount: '70',
      },
    ];
    const repo = { find: jest.fn(async ({ where }: any) => (where.reversesLedgerId ? [] : rows)) };
    const service: any = new PartnerProviderManualLedgerService({} as never, {} as never, ledger as never);
    service.settlementContext = jest.fn().mockResolvedValue({
      partnerCompanyId: 7,
      settleMethod: 'PER_PRODUCT',
      snapshot: {},
      subItem: { giftKind: null, brandCode: null, snapshotProductExpireDay: null },
    });
    const manager = { getRepository: jest.fn(() => repo) };
    const result = await service.appendLedgers(
      {
        id: 4,
        provider: 'GALAXIA',
        sourceType: 'USAGE',
        proposedLedgerFacts: { baseAmount: '-100', occurredAt: '2026-08-06 10:00:00', giftKind: 'cpn' },
        evidenceRef: 'ticket://4',
        evidenceHash: 'hash',
        reason: 'cancel',
      },
      {
        id: 9,
        orderDeliveryId: 11,
        sourceType: 'USAGE',
        normalizedPayload: { amount: 100, appDiv: '20', giftKind: 'cpn' },
      } as never,
      manager,
    );

    expect(result).toEqual([22, 21]);
    expect(
      ledger.appendReversal.mock.calls.map((call: any[]) => [call[0].reversesLedgerId, call[0].cancelBaseAmount]),
    ).toEqual([
      [2, 40n],
      [1, 60n],
    ]);
  });

  describe('validateProposedFacts — evidence cross-check (BLOCKER regression)', () => {
    function buildService(contextOverride?: Partial<Record<string, unknown>>) {
      const service: any = new PartnerProviderManualLedgerService({} as never, {} as never, {} as never);
      service.settlementContext = jest.fn().mockResolvedValue({
        partnerCompanyId: 7,
        settleMethod: 'PER_PRODUCT',
        snapshot: { price: 5000, category: null, classificationId: null, brandNameKorean: null },
        subItem: { giftKind: null, brandCode: null, snapshotProductExpireDay: null },
        ...contextOverride,
      });
      return service;
    }

    // --- USAGE: appDiv sign enforcement ---

    it('USAGE appDiv=10 + matching positive baseAmount → passes', () => {
      const service = buildService();
      const inbox = { sourceType: 'USAGE', normalizedPayload: { amount: 5000, appDiv: '10', giftKind: 'cpn' } };
      expect(() => service.validateProposedFacts({ baseAmount: '5000', giftKind: 'cpn' }, inbox, {})).not.toThrow();
    });

    it('USAGE appDiv=10 + negative baseAmount → rejects (sign mismatch)', () => {
      const service = buildService();
      const inbox = { sourceType: 'USAGE', normalizedPayload: { amount: 5000, appDiv: '10', giftKind: 'cpn' } };
      expect(() => service.validateProposedFacts({ baseAmount: '-5000', giftKind: 'cpn' }, inbox, {})).toThrow(
        UnprocessableEntityException,
      );
    });

    it('USAGE appDiv=10 + wrong magnitude → rejects', () => {
      const service = buildService();
      const inbox = { sourceType: 'USAGE', normalizedPayload: { amount: 5000, appDiv: '10' } };
      expect(() => service.validateProposedFacts({ baseAmount: '9999' }, inbox, {})).toThrow(
        UnprocessableEntityException,
      );
    });

    it('USAGE appDiv=20 (cancel) + matching negative baseAmount → passes', () => {
      const service = buildService();
      const inbox = { sourceType: 'USAGE', normalizedPayload: { amount: 3000, appDiv: '20' } };
      expect(() => service.validateProposedFacts({ baseAmount: '-3000' }, inbox, {})).not.toThrow();
    });

    it('USAGE appDiv=25 (cancel) + matching negative baseAmount → passes', () => {
      const service = buildService();
      const inbox = { sourceType: 'USAGE', normalizedPayload: { amount: 3000, appDiv: '25' } };
      expect(() => service.validateProposedFacts({ baseAmount: '-3000' }, inbox, {})).not.toThrow();
    });

    it('USAGE appDiv=81 (cancel) + matching negative baseAmount → passes', () => {
      const service = buildService();
      const inbox = { sourceType: 'USAGE', normalizedPayload: { amount: 3000, appDiv: '81' } };
      expect(() => service.validateProposedFacts({ baseAmount: '-3000' }, inbox, {})).not.toThrow();
    });

    it('USAGE appDiv=20 + positive baseAmount → rejects (orphan cancel approved as forward)', () => {
      const service = buildService();
      const inbox = { sourceType: 'USAGE', normalizedPayload: { amount: 5000, appDiv: '20' } };
      expect(() => service.validateProposedFacts({ baseAmount: '5000' }, inbox, {})).toThrow(
        UnprocessableEntityException,
      );
    });

    it('USAGE appDiv=81 + positive baseAmount → rejects', () => {
      const service = buildService();
      const inbox = { sourceType: 'USAGE', normalizedPayload: { amount: 5000, appDiv: '81' } };
      expect(() => service.validateProposedFacts({ baseAmount: '5000' }, inbox, {})).toThrow(
        UnprocessableEntityException,
      );
    });

    it('USAGE appDiv=20 + wrong cancellation amount → rejects', () => {
      const service = buildService();
      const inbox = { sourceType: 'USAGE', normalizedPayload: { amount: 5000, appDiv: '20' } };
      expect(() => service.validateProposedFacts({ baseAmount: '-9999' }, inbox, {})).toThrow(
        UnprocessableEntityException,
      );
    });

    it('USAGE unknown appDiv → rejects', () => {
      const service = buildService();
      const inbox = { sourceType: 'USAGE', normalizedPayload: { amount: 5000, appDiv: '99' } };
      expect(() => service.validateProposedFacts({ baseAmount: '5000' }, inbox, {})).toThrow(BadRequestException);
    });

    // --- USAGE: amount evidence missing ---

    it('USAGE without inbox amount → rejects', () => {
      const service = buildService();
      const inbox = { sourceType: 'USAGE', normalizedPayload: { appDiv: '10' } };
      expect(() => service.validateProposedFacts({ baseAmount: '5000' }, inbox, {})).toThrow(BadRequestException);
    });

    // --- USAGE: no appDiv (non-Galaxia) — magnitude-only validation ---

    it('USAGE without appDiv + matching absolute amount → passes (positive)', () => {
      const service = buildService();
      const inbox = { sourceType: 'USAGE', normalizedPayload: { amount: '5000' } };
      expect(() => service.validateProposedFacts({ baseAmount: '5000' }, inbox, {})).not.toThrow();
    });

    it('USAGE without appDiv + matching absolute amount → passes (negative)', () => {
      const service = buildService();
      const inbox = { sourceType: 'USAGE', normalizedPayload: { amount: '5000' } };
      expect(() => service.validateProposedFacts({ baseAmount: '-5000' }, inbox, {})).not.toThrow();
    });

    it('USAGE without appDiv + wrong absolute amount → rejects', () => {
      const service = buildService();
      const inbox = { sourceType: 'USAGE', normalizedPayload: { amount: '5000' } };
      expect(() => service.validateProposedFacts({ baseAmount: '9999' }, inbox, {})).toThrow(
        UnprocessableEntityException,
      );
    });

    // --- ISSUANCE / EXCHANGE: snapshot price + provider sign enforcement ---

    it('ISSUANCE (Galaxia appDiv=10) + matching positive baseAmount → passes', () => {
      const service = buildService();
      const inbox = { sourceType: 'ISSUANCE', normalizedPayload: { appDiv: '10' } };
      const context = { snapshot: { price: 5000 } };
      expect(() => service.validateProposedFacts({ baseAmount: '5000' }, inbox, context)).not.toThrow();
    });

    it('EXCHANGE (Galaxia appDiv=20 cancel) + matching negative baseAmount → passes', () => {
      const service = buildService();
      const inbox = { sourceType: 'EXCHANGE', normalizedPayload: { appDiv: '20' } };
      const context = { snapshot: { price: 5000 } };
      expect(() => service.validateProposedFacts({ baseAmount: '-5000' }, inbox, context)).not.toThrow();
    });

    it('ISSUANCE (Galaxia appDiv=10) + wrong amount → rejects', () => {
      const service = buildService();
      const inbox = { sourceType: 'ISSUANCE', normalizedPayload: { appDiv: '10' } };
      const context = { snapshot: { price: 5000 } };
      expect(() => service.validateProposedFacts({ baseAmount: '9999' }, inbox, context)).toThrow(
        UnprocessableEntityException,
      );
    });

    it('EXCHANGE (Galaxia appDiv=20) + wrong cancellation amount → rejects', () => {
      const service = buildService();
      const inbox = { sourceType: 'EXCHANGE', normalizedPayload: { appDiv: '20' } };
      const context = { snapshot: { price: 5000 } };
      expect(() => service.validateProposedFacts({ baseAmount: '-9999' }, inbox, context)).toThrow(
        UnprocessableEntityException,
      );
    });

    it('ISSUANCE + null snapshot price → rejects', () => {
      const service = buildService();
      const inbox = { sourceType: 'ISSUANCE', normalizedPayload: { appDiv: '10' } };
      const context = { snapshot: { price: null } };
      expect(() => service.validateProposedFacts({ baseAmount: '5000' }, inbox, context)).toThrow(BadRequestException);
    });

    // --- BLOCKER regression: ISSUANCE/EXCHANGE sign enforcement ---

    it('EXCHANGE (Galaxia appDiv=10 forward) + negative baseAmount → rejects (wrong sign)', () => {
      const service = buildService();
      const inbox = { sourceType: 'EXCHANGE', normalizedPayload: { appDiv: '10' } };
      const context = { snapshot: { price: 5000 } };
      expect(() => service.validateProposedFacts({ baseAmount: '-5000' }, inbox, context)).toThrow(
        UnprocessableEntityException,
      );
    });

    it('EXCHANGE (Galaxia appDiv=20 cancel) + positive baseAmount → rejects (wrong sign)', () => {
      const service = buildService();
      const inbox = { sourceType: 'EXCHANGE', normalizedPayload: { appDiv: '20' } };
      const context = { snapshot: { price: 5000 } };
      expect(() => service.validateProposedFacts({ baseAmount: '5000' }, inbox, context)).toThrow(
        UnprocessableEntityException,
      );
    });

    it('EXCHANGE (Galaxia appDiv=25 cancel) + positive baseAmount → rejects (wrong sign)', () => {
      const service = buildService();
      const inbox = { sourceType: 'EXCHANGE', normalizedPayload: { appDiv: '25' } };
      const context = { snapshot: { price: 5000 } };
      expect(() => service.validateProposedFacts({ baseAmount: '5000' }, inbox, context)).toThrow(
        UnprocessableEntityException,
      );
    });

    it('EXCHANGE (Galaxia appDiv=81 cancel) + positive baseAmount → rejects (wrong sign)', () => {
      const service = buildService();
      const inbox = { sourceType: 'EXCHANGE', normalizedPayload: { appDiv: '81' } };
      const context = { snapshot: { price: 5000 } };
      expect(() => service.validateProposedFacts({ baseAmount: '5000' }, inbox, context)).toThrow(
        UnprocessableEntityException,
      );
    });

    it('ISSUANCE (Galaxia appDiv=10) + negative baseAmount → rejects (wrong sign)', () => {
      const service = buildService();
      const inbox = { sourceType: 'ISSUANCE', normalizedPayload: { appDiv: '10' } };
      const context = { snapshot: { price: 5000 } };
      expect(() => service.validateProposedFacts({ baseAmount: '-5000' }, inbox, context)).toThrow(
        UnprocessableEntityException,
      );
    });

    it('ISSUANCE (Galaxia unknown appDiv) → rejects', () => {
      const service = buildService();
      const inbox = { sourceType: 'ISSUANCE', normalizedPayload: { appDiv: '99' } };
      const context = { snapshot: { price: 5000 } };
      expect(() => service.validateProposedFacts({ baseAmount: '5000' }, inbox, context)).toThrow(BadRequestException);
    });

    // --- GiftShow pinStatusCd sign enforcement ---

    it('EXCHANGE (GiftShow pinStatusCd=02 exchange) + positive baseAmount → passes', () => {
      const service = buildService();
      const inbox = { sourceType: 'EXCHANGE', normalizedPayload: { pinStatusCd: '02' } };
      const context = { snapshot: { price: 5000 } };
      expect(() => service.validateProposedFacts({ baseAmount: '5000' }, inbox, context)).not.toThrow();
    });

    it('EXCHANGE (GiftShow pinStatusCd=07 cancel) + negative baseAmount → passes', () => {
      const service = buildService();
      const inbox = { sourceType: 'EXCHANGE', normalizedPayload: { pinStatusCd: '07' } };
      const context = { snapshot: { price: 5000 } };
      expect(() => service.validateProposedFacts({ baseAmount: '-5000' }, inbox, context)).not.toThrow();
    });

    it('EXCHANGE (GiftShow pinStatusCd=02 exchange) + negative baseAmount → rejects (wrong sign)', () => {
      const service = buildService();
      const inbox = { sourceType: 'EXCHANGE', normalizedPayload: { pinStatusCd: '02' } };
      const context = { snapshot: { price: 5000 } };
      expect(() => service.validateProposedFacts({ baseAmount: '-5000' }, inbox, context)).toThrow(
        UnprocessableEntityException,
      );
    });

    it('EXCHANGE (GiftShow pinStatusCd=07 cancel) + positive baseAmount → rejects (wrong sign)', () => {
      const service = buildService();
      const inbox = { sourceType: 'EXCHANGE', normalizedPayload: { pinStatusCd: '07' } };
      const context = { snapshot: { price: 5000 } };
      expect(() => service.validateProposedFacts({ baseAmount: '5000' }, inbox, context)).toThrow(
        UnprocessableEntityException,
      );
    });

    it('ISSUANCE (GiftShow pinStatusCd=01 issued) + positive baseAmount → passes', () => {
      const service = buildService();
      const inbox = { sourceType: 'ISSUANCE', normalizedPayload: { pinStatusCd: '01' } };
      const context = { snapshot: { price: 5000 } };
      expect(() => service.validateProposedFacts({ baseAmount: '5000' }, inbox, context)).not.toThrow();
    });

    it('GiftShow unsupported pinStatusCd=08 → rejects', () => {
      const service = buildService();
      const inbox = { sourceType: 'EXCHANGE', normalizedPayload: { pinStatusCd: '08' } };
      const context = { snapshot: { price: 5000 } };
      expect(() => service.validateProposedFacts({ baseAmount: '5000' }, inbox, context)).toThrow(BadRequestException);
    });

    // --- Missing provider evidence → rejects ---

    it('ISSUANCE without appDiv or pinStatusCd → rejects (no evidence for sign)', () => {
      const service = buildService();
      const inbox = { sourceType: 'ISSUANCE', normalizedPayload: {} };
      const context = { snapshot: { price: 5000 } };
      expect(() => service.validateProposedFacts({ baseAmount: '5000' }, inbox, context)).toThrow(BadRequestException);
    });

    it('EXCHANGE without appDiv or pinStatusCd → rejects (no evidence for sign)', () => {
      const service = buildService();
      const inbox = { sourceType: 'EXCHANGE', normalizedPayload: {} };
      const context = { snapshot: { price: 5000 } };
      expect(() => service.validateProposedFacts({ baseAmount: '-5000' }, inbox, context)).toThrow(BadRequestException);
    });

    // --- giftKind cross-check ---

    it('giftKind mismatch with inbox evidence → rejects', () => {
      const service = buildService();
      const inbox = { sourceType: 'USAGE', normalizedPayload: { amount: 5000, appDiv: '10', giftKind: 'cpn' } };
      expect(() => service.validateProposedFacts({ baseAmount: '5000', giftKind: 'dept' }, inbox, {})).toThrow(
        BadRequestException,
      );
    });

    it('giftKind matches inbox evidence → passes', () => {
      const service = buildService();
      const inbox = { sourceType: 'USAGE', normalizedPayload: { amount: 5000, appDiv: '10', giftKind: 'cpn' } };
      expect(() => service.validateProposedFacts({ baseAmount: '5000', giftKind: 'cpn' }, inbox, {})).not.toThrow();
    });

    it('giftKind in facts but not in inbox → passes (no evidence to contradict)', () => {
      const service = buildService();
      const inbox = { sourceType: 'USAGE', normalizedPayload: { amount: 5000, appDiv: '10' } };
      expect(() => service.validateProposedFacts({ baseAmount: '5000', giftKind: 'cpn' }, inbox, {})).not.toThrow();
    });
  });
});
