import { BadRequestException } from '@nestjs/common';
import { PartnerSettleTransitionResolutionService } from './partner.settle.transition.resolution.service';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { PartnerProviderEventInboxEntity } from '../../entity/partner.provider.event.inbox.entity';
import { PartnerSettleTransitionResolutionEntity } from '../../entity/partner.settle.transition.resolution.entity';
import { PartnerSettleTransitionObservationEntity } from '../../entity/partner.settle.transition.observation.entity';
import { ConflictException, ForbiddenException } from '@nestjs/common';

describe('PartnerSettleTransitionResolutionService v2 normalization', () => {
  const service = new PartnerSettleTransitionResolutionService({} as never, {} as never, {} as never, {} as never);
  const command = () => ({
    requestKey: 'v2-1',
    transitions: [
      {
        prevStatus: '01',
        newStatus: '02',
        sourceEventIdOrigin: 'MANUAL' as const,
        providerEvidenceRef: 'INBOX:1',
        sourceOccurredAt: '2026-08-06 10:00:00.000001',
        occurredAt: '2026-08-06 10:00:00.000001',
        ledgerFacts: {
          action: 'REVERSAL' as const,
          allocations: [
            { reversesLedgerId: 9, cancelBaseAmount: '2' },
            { reversesLedgerId: 3, cancelBaseAmount: '1' },
          ],
        },
      },
    ],
  });
  it('hashes server evidence and sorts reversal allocations', () => {
    const normalized = (service as any).normalize(command());
    expect(normalized.transitions[0].providerEvidenceHash).toHaveLength(64);
    expect(
      normalized.transitions[0].ledgerFacts.allocations.map(
        (item: { reversesLedgerId: number }) => item.reversesLedgerId,
      ),
    ).toEqual([3, 9]);
    expect((service as any).payloadHash(1, normalized)).not.toEqual((service as any).payloadHash(2, normalized));
  });
  it('rejects duplicate allocations and noncanonical amounts', () => {
    const duplicate = command();
    duplicate.transitions[0].ledgerFacts.allocations[1].reversesLedgerId = 9;
    expect(() => (service as any).normalize(duplicate)).toThrow(BadRequestException);
    const invalid = command();
    invalid.transitions[0].ledgerFacts.allocations[0].cancelBaseAmount = '01';
    expect(() => (service as any).normalize(invalid)).toThrow(BadRequestException);
  });
});
describe('v2 accounting facts', () => {
  const service = new PartnerSettleTransitionResolutionService({} as never, {} as never, {} as never, {} as never);
  const context: any = { snapshot: { price: '100' }, subItem: {}, partnerCompanyId: 1, orderDeliveryId: 7 };
  const observation = (over: any = {}) => ({
    id: 4,
    provider: 'GALAXIA',
    sourceType: 'USAGE',
    orderDeliveryId: 7,
    ...over,
  });
  const transition = (facts: any, code = '10') => ({
    prevStatus: '01',
    newStatus: code,
    sourceEventIdOrigin: 'MANUAL',
    ledgerFacts: facts,
  });
  const inbox: any = { normalizedPayload: { amount: '55', giftKind: 'cpn' } };

  it('uses linked INBOX amount for USAGE forward rather than snapshot price', () => {
    expect(() =>
      (service as any).validateAccounting(
        observation(),
        context,
        transition({ action: 'FORWARD', baseAmount: '55', subItemKey: 'GALAXIA_MOBILE' }),
        inbox,
      ),
    ).not.toThrow();
    expect(() =>
      (service as any).validateAccounting(
        observation(),
        context,
        transition({ action: 'FORWARD', baseAmount: '100', subItemKey: 'GALAXIA_MOBILE' }),
        inbox,
      ),
    ).toThrow(BadRequestException);
  });
  it('uses immutable snapshot price for EXCHANGE forward and provider action matrix', () => {
    const obs = observation({ provider: 'SSG', sourceType: 'EXCHANGE' });
    expect(() =>
      (service as any).validateAccounting(
        obs,
        context,
        transition({ action: 'FORWARD', baseAmount: '100', subItemKey: 'NONE' }, '0400'),
        null,
      ),
    ).not.toThrow();
    expect(() =>
      (service as any).validateAccounting(
        obs,
        context,
        transition({ action: 'REVERSAL', allocations: [{ cancelBaseAmount: '1' }] }, '0400'),
        inbox,
      ),
    ).toThrow(BadRequestException);
  });
  it('fails closed for missing Galaxia evidence and validates reversal aggregate', () => {
    expect(() => (service as any).subItemFor(observation(), context, null)).toThrow(BadRequestException);
    expect(() =>
      (service as any).validateAccounting(
        observation(),
        context,
        transition({ action: 'REVERSAL', allocations: [{ cancelBaseAmount: '54' }] }, '20'),
        inbox,
      ),
    ).toThrow(BadRequestException);
  });
  it('requires a canonical reject reason before transaction work', async () => {
    await expect(service.reject(1, 2, '  ')).rejects.toBeInstanceOf(BadRequestException);
  });
});
describe('public proposal and decision ledger contract', () => {
  const forward = {
    prevStatus: '01',
    newStatus: '02',
    sourceEventIdOrigin: 'MANUAL',
    sourceEventId: null,
    providerEvidenceRef: 'INBOX:9',
    providerEvidenceHash: 'evidence',
    sourceOccurredAt: '2026-08-06 10:00:00.000001',
    occurredAt: '2026-08-06 10:00:00.000001',
    ledgerFacts: { action: 'FORWARD', baseAmount: '100', subItemKey: 'NONE' },
  };
  const observation = {
    id: 4,
    provider: 'GIFT_SHOW',
    sourceType: 'EXCHANGE',
    orderDeliveryId: 7,
    prevStatus: '01',
    newStatus: '02',
    resolutionStatus: 'UNRESOLVED',
    unresolvedEvidenceKey: 'INBOX:9',
  };
  const delivery = {
    id: 7,
    orderProductMapping: {
      snapshotProductPrice: '100',
      product: { partnerCompanyId: 12, settleMethod: 'PER_EXCHANGE' },
    },
  };
  const evidence = {
    id: 9,
    observationId: 4,
    orderDeliveryId: 7,
    provider: 'GIFT_SHOW',
    sourceType: 'EXCHANGE',
    processedStatus: 'LINKED',
    normalizedPayload: { amount: '100' },
  };

  function approvalHarness(proposal: any, ledgerRows: any[] = [], lockedObservation: any = observation) {
    const resolution = {
      findOne: jest.fn().mockResolvedValueOnce(proposal).mockResolvedValueOnce(proposal),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const observations = {
      findOne: jest.fn().mockResolvedValueOnce(lockedObservation).mockResolvedValueOnce(lockedObservation),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const manager = {
      getRepository: jest.fn((entity: unknown) =>
        entity === PartnerSettleTransitionResolutionEntity
          ? resolution
          : entity === PartnerSettleTransitionObservationEntity
            ? observations
            : entity === OrderDeliveryEntity
              ? { findOne: jest.fn().mockResolvedValue(delivery) }
              : entity === PartnerProviderEventInboxEntity
                ? { findOne: jest.fn().mockResolvedValue(evidence) }
                : {
                    findOne: jest.fn().mockResolvedValue({
                      id: 1,
                      orderDeliveryId: 7,
                      partnerCompanyId: 12,
                      sourceType: 'EXCHANGE',
                      reversesLedgerId: null,
                    }),
                    find: jest.fn().mockResolvedValue(ledgerRows),
                  },
      ),
    };
    const dataSource = { transaction: jest.fn((work: any) => work(manager)) };
    const ledger = {
      lockForAppend: jest.fn().mockResolvedValue(undefined),
      appendLedger: jest.fn().mockResolvedValue({ id: 71 }),
      appendReversal: jest.fn().mockResolvedValue({ id: 72 }),
    };
    return {
      service: new PartnerSettleTransitionResolutionService(
        {} as never,
        {} as never,
        dataSource as never,
        ledger as never,
      ),
      resolution,
      observations,
      manager,
      ledger,
    };
  }

  it('replays a matching requestKey payload and conflicts on a different hash', async () => {
    const existing = { id: 5, observationId: 4, requestKey: 'request-1', payloadHashVersion: 'v2' } as any;
    const repository = { findOne: jest.fn().mockResolvedValue(existing) };
    const service = new PartnerSettleTransitionResolutionService(
      repository as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const command = { requestKey: 'request-1', transitions: [forward] };
    existing.payloadHash = (service as any).payloadHash(4, (service as any).normalize(command));
    await expect(service.propose(4, command, 3)).resolves.toEqual({ proposal: existing, ledgerIds: [] });
    await expect(
      service.propose(
        4,
        { ...command, transitions: [{ ...forward, ledgerFacts: { ...forward.ledgerFacts, baseAmount: '101' } }] },
        3,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('stops self-approval before appending or terminal CAS', async () => {
    const { service, ledger, resolution, observations } = approvalHarness({
      id: 5,
      observationId: 4,
      status: 'PENDING',
      proposedBy: 3,
      proposedTransitions: [forward],
    });
    await expect(service.approve(5, 3)).rejects.toBeInstanceOf(ForbiddenException);
    expect(ledger.appendLedger).not.toHaveBeenCalled();
    expect(resolution.update).not.toHaveBeenCalled();
    expect(observations.update).not.toHaveBeenCalled();
  });

  it('locks context and evidence, appends FORWARD with manager transition metadata, then CASes', async () => {
    const proposal = {
      id: 5,
      observationId: 4,
      status: 'PENDING',
      proposedBy: 3,
      proposedTransitions: [forward],
      resolutionBundleHash: 'bundle',
    };
    const { service, ledger, resolution, observations, manager } = approvalHarness(proposal);
    await expect(service.approve(5, 8, 'approved')).resolves.toMatchObject({ ledgerIds: [71] });
    expect(ledger.lockForAppend).toHaveBeenCalledWith(12, 7, manager);
    expect(manager.getRepository).toHaveBeenCalledWith(OrderDeliveryEntity);
    expect(manager.getRepository).toHaveBeenCalledWith(PartnerProviderEventInboxEntity);
    expect(ledger.appendLedger).toHaveBeenCalledWith(
      expect.objectContaining({
        transition: { observationId: 4, sequenceNo: 1, allocationNo: 1, sourceEventIdOrigin: 'MANUAL' },
      }),
      manager,
    );
    expect(resolution.update.mock.invocationCallOrder[0]).toBeGreaterThan(
      ledger.appendLedger.mock.invocationCallOrder[0],
    );
    expect(observations.update.mock.invocationCallOrder[0]).toBeGreaterThan(
      ledger.appendLedger.mock.invocationCallOrder[0],
    );
  });

  it('sorts and scopes two REVERSAL allocations, appending both before terminal CAS', async () => {
    const reversal = {
      ...forward,
      newStatus: '07',
      ledgerFacts: {
        action: 'REVERSAL',
        allocations: [
          { reversesLedgerId: 9, cancelBaseAmount: '40' },
          { reversesLedgerId: 3, cancelBaseAmount: '60' },
        ],
      },
    };
    const proposal = {
      id: 5,
      observationId: 4,
      status: 'PENDING',
      proposedBy: 3,
      proposedTransitions: [
        {
          ...reversal,
          ledgerFacts: {
            ...reversal.ledgerFacts,
            allocations: [...reversal.ledgerFacts.allocations].sort((a, b) => a.reversesLedgerId - b.reversesLedgerId),
          },
        },
      ],
      resolutionBundleHash: 'bundle',
    };
    const { service, ledger, resolution, observations, manager } = approvalHarness(proposal, [], {
      ...observation,
      newStatus: '07',
    });
    await service.approve(5, 8);
    expect(ledger.appendReversal).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ reversesLedgerId: 3, transition: expect.objectContaining({ allocationNo: 1 }) }),
      manager,
    );
    expect(ledger.appendReversal).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ reversesLedgerId: 9, transition: expect.objectContaining({ allocationNo: 2 }) }),
      manager,
    );
    expect(resolution.update.mock.invocationCallOrder[0]).toBeGreaterThan(
      ledger.appendReversal.mock.invocationCallOrder[1],
    );
    expect(observations.update.mock.invocationCallOrder[0]).toBeGreaterThan(
      ledger.appendReversal.mock.invocationCallOrder[1],
    );
  });

  it('does not terminal-CAS when append fails', async () => {
    const { service, ledger, resolution, observations } = approvalHarness({
      id: 5,
      observationId: 4,
      status: 'PENDING',
      proposedBy: 3,
      proposedTransitions: [forward],
    });
    ledger.appendLedger.mockRejectedValueOnce(new Error('append failed'));
    await expect(service.approve(5, 8)).rejects.toThrow('append failed');
    expect(resolution.update).not.toHaveBeenCalled();
    expect(observations.update).not.toHaveBeenCalled();
  });

  it('validates APPROVED replay rows and makes same reject idempotent while opposite decision conflicts', async () => {
    const approved = { id: 5, observationId: 4, status: 'APPROVED', proposedBy: 3, proposedTransitions: [forward] };
    const validRows = [{ id: 71, transitionSequenceNo: 1, transitionAllocationNo: 1, sourceEventIdOrigin: 'MANUAL' }];
    await expect(approvalHarness(approved, validRows).service.approve(5, 8)).resolves.toMatchObject({
      ledgerIds: [71],
    });
    const invalidRows = [{ ...validRows[0], sourceEventIdOrigin: 'PROVIDER' }];
    await expect(approvalHarness(approved, invalidRows).service.approve(5, 8)).rejects.toBeInstanceOf(
      ConflictException,
    );
    const rejected = { id: 5, observationId: 4, status: 'REJECTED', proposedBy: 3 };
    await expect(approvalHarness(rejected).service.reject(5, 8, 'reason')).resolves.toEqual({
      proposal: rejected,
      ledgerIds: [],
    });
    await expect(
      approvalHarness({ ...rejected, status: 'APPROVED' }).service.reject(5, 8, 'reason'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
